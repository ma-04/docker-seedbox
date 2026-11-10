// vpn control server: WireGuard client + kill switch for the qbittorrent network namespace.
package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/netip"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

func logf(format string, a ...any) { log.Printf(format, a...) }

type Server struct {
	token, webPorts, pubURL, fallbackDNS string
	lan                                  []netip.Prefix
	handshakeTimeout                     time.Duration
	origNS, origResolv                   string

	opMu sync.Mutex // serialises mutating operations

	mu       sync.Mutex // guards the fields below
	mode     string
	iface    string
	name     string
	since    int64
	endpoint netip.AddrPort
	gen      int
	pubIP    string
	pubGen   int
	pubAt    time.Time
	pubTry   time.Time
}

type statusDTO struct {
	Mode             string  `json:"mode"`
	Connected        bool    `json:"connected"`
	Name             *string `json:"name"`
	PublicIP         *string `json:"publicIp"`
	LastHandshakeSec *int64  `json:"lastHandshakeSec"`
	Since            *int64  `json:"since"`
}

func (s *Server) status() statusDTO {
	s.mu.Lock()
	mode, iface, name, since, ip := s.mode, s.iface, s.name, s.since, s.pubIP
	s.mu.Unlock()
	d := statusDTO{Mode: mode}
	if iface == "" {
		return d
	}
	d.Name, d.Since = &name, &since
	if age, ok := handshakeAge(iface); ok {
		d.LastHandshakeSec = &age
		d.Connected = age <= 180
	}
	if d.Connected && ip != "" {
		d.PublicIP = &ip
	}
	return d
}

var errBadRequest = errors.New("bad request")

func (s *Server) rules(mode string, eps ...netip.AddrPort) string {
	return buildRuleset(mode, s.lan, eps, s.webPorts)
}

func (s *Server) failClosedDNS() { writeResolv("# vpn: no tunnel up, DNS disabled (kill switch)\n") }
func (s *Server) openDNS()       { writeResolv(s.origResolv) }

func (s *Server) connect(name string, cfg *WGConfig) (err error) {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	ep, err := s.resolveEndpoint(cfg.EndpointHost, cfg.EndpointPort)
	if err != nil {
		return fmt.Errorf("%w: %v", errBadRequest, err)
	}
	gw, dev, err := defaultRoute()
	if err != nil {
		return err
	}
	s.mu.Lock()
	mode, oldIf, oldEp := s.mode, s.iface, s.endpoint
	s.mu.Unlock()
	newIf := "wg0"
	if oldIf == "wg0" {
		newIf = "wg1"
	}
	eps := []netip.AddrPort{ep}
	if oldIf != "" {
		eps = append(eps, oldEp)
	}
	// Allow the new endpoint before anything else; the old tunnel keeps working until the new one has a handshake.
	if mode == "required" {
		if err := applyRuleset(s.rules("required", eps...)); err != nil {
			return err
		}
	}
	restore := func() {
		_, _ = run("", "ip", "link", "del", newIf)
		if oldIf == "" || oldEp.Addr() != ep.Addr() {
			_, _ = run("", "ip", "-4", "route", "del", ep.Addr().String()+"/32")
		}
		if mode == "required" {
			var keep []netip.AddrPort
			if oldIf != "" {
				keep = append(keep, oldEp)
			}
			_ = applyRuleset(s.rules("required", keep...))
		}
	}
	_, _ = run("", "ip", "link", "del", newIf) // stale leftovers
	if _, err = run("", "ip", "link", "add", newIf, "type", "wireguard"); err != nil {
		return err
	}
	fail := func(e error) error { restore(); return e }
	if err = wgSetConf(newIf, cfg, ep); err != nil {
		return fail(err)
	}
	for _, a := range cfg.Addresses {
		if _, err = run("", "ip", "-4", "addr", "add", a.String(), "dev", newIf); err != nil {
			return fail(err)
		}
	}
	if _, err = run("", "ip", "link", "set", newIf, "mtu", strconv.Itoa(cfg.MTU), "up"); err != nil {
		return fail(err)
	}
	if _, err = run("", "ip", routeArgs(ep.Addr().String()+"/32", gw, dev)...); err != nil {
		return fail(err)
	}
	deadline := time.Now().Add(s.handshakeTimeout)
	for {
		if _, ok := handshakeAge(newIf); ok {
			break
		}
		if time.Now().After(deadline) {
			return fail(fmt.Errorf("%w: no WireGuard handshake within %s (wrong keys, endpoint down or UDP blocked)", errHandshake, s.handshakeTimeout))
		}
		time.Sleep(250 * time.Millisecond)
	}
	// Handshake done: swing the routes over (route replace is atomic per prefix), then drop the old tunnel.
	for _, p := range cfg.AllowedIPs {
		var prefixes []string
		if p.Bits() == 0 {
			prefixes = []string{"0.0.0.0/1", "128.0.0.0/1"}
		} else {
			prefixes = []string{p.String()}
		}
		for _, x := range prefixes {
			if _, err = run("", "ip", "-4", "route", "replace", x, "dev", newIf); err != nil {
				return fail(err)
			}
		}
	}
	for _, c := range s.lan { // keep LAN CIDRs on the normal route
		if out, _ := run("", "ip", "-4", "route", "show", "exact", c.String()); out == "" {
			_, _ = run("", "ip", routeArgs(c.String(), gw, dev)...)
		}
	}
	dns := "nameserver " + s.fallbackDNS + "\n"
	if len(cfg.DNS) > 0 {
		dns = ""
		for _, d := range cfg.DNS {
			dns += "nameserver " + d.String() + "\n"
		}
	}
	writeResolv(dns + "options ndots:0\n")
	if oldIf != "" {
		_, _ = run("", "ip", "link", "del", oldIf)
		if oldEp.Addr() != ep.Addr() {
			_, _ = run("", "ip", "-4", "route", "del", oldEp.Addr().String()+"/32")
		}
	}
	s.mu.Lock()
	s.iface, s.name, s.since, s.endpoint = newIf, name, time.Now().Unix(), ep
	s.gen++
	s.pubIP = ""
	s.mu.Unlock()
	if mode == "required" {
		if err := applyRuleset(s.rules("required", ep)); err != nil {
			logf("warn: %v", err)
		}
	}
	return nil
}

var errHandshake = errors.New("handshake failed")

// teardown removes the tunnel (if any). The caller holds opMu.
func (s *Server) teardown() {
	s.mu.Lock()
	iface, ep := s.iface, s.endpoint
	s.iface, s.name, s.since, s.pubIP = "", "", 0, ""
	s.gen++
	s.mu.Unlock()
	if iface != "" {
		_, _ = run("", "ip", "link", "del", iface)
		_, _ = run("", "ip", "-4", "route", "del", ep.Addr().String()+"/32")
	}
}

func (s *Server) disconnect() {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	s.teardown()
	s.mu.Lock()
	mode := s.mode
	s.mu.Unlock()
	if mode == "required" {
		s.failClosedDNS()
		if err := applyRuleset(s.rules("required")); err != nil {
			logf("warn: %v", err)
		}
	} else {
		s.openDNS()
	}
}

func (s *Server) setMode(mode string) error {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	s.mu.Lock()
	cur, ep, up := s.mode, s.endpoint, s.iface != ""
	s.mu.Unlock()
	if mode == "required" {
		var eps []netip.AddrPort
		if up {
			eps = append(eps, ep)
		}
		if err := applyRuleset(s.rules("required", eps...)); err != nil {
			return err
		}
		if !up {
			s.failClosedDNS()
		}
	} else {
		if cur != mode || up {
			s.teardown() // off = normal container route; the tunnel goes away
		}
		s.openDNS()
		if err := applyRuleset(s.rules("off")); err != nil {
			return err
		}
	}
	s.mu.Lock()
	s.mode = mode
	s.mu.Unlock()
	return nil
}

var ipRe = regexp.MustCompile(`(\d{1,3}\.){3}\d{1,3}`)

func (s *Server) publicIPLoop() {
	if s.pubURL == "" {
		return
	}
	for range time.Tick(2 * time.Second) {
		s.mu.Lock()
		due := s.iface != "" && ((s.pubGen != s.gen && time.Since(s.pubTry) > 5*time.Second) || (s.pubIP != "" && time.Since(s.pubAt) > 10*time.Minute))
		gen := s.gen
		if due {
			s.pubTry = time.Now()
		}
		s.mu.Unlock()
		if !due {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		req, _ := http.NewRequestWithContext(ctx, "GET", s.pubURL, nil)
		resp, err := http.DefaultClient.Do(req)
		ip := ""
		if err == nil {
			b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
			resp.Body.Close()
			if m := ipRe.FindString(string(b)); m != "" && resp.StatusCode == 200 {
				ip = m
			}
		}
		cancel()
		s.mu.Lock()
		if s.gen == gen && ip != "" {
			s.pubIP, s.pubGen, s.pubAt = ip, gen, time.Now()
		}
		s.mu.Unlock()
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func (s *Server) handler() http.Handler {
	mux := http.NewServeMux()
	body := func(w http.ResponseWriter, r *http.Request, v any) bool {
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024))
		if err := dec.Decode(v); err != nil {
			fail(w, 400, "invalid JSON body")
			return false
		}
		return true
	}
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, s.status()) })
	mux.HandleFunc("POST /connect", func(w http.ResponseWriter, r *http.Request) {
		var in struct{ Name, Config string }
		if !body(w, r, &in) {
			return
		}
		if !validName(in.Name) {
			fail(w, 400, "invalid name")
			return
		}
		cfg, err := ParseWGConfig(in.Config)
		if err != nil {
			fail(w, 400, err.Error())
			return
		}
		if err := s.connect(in.Name, cfg); err != nil {
			code := 500
			if errors.Is(err, errBadRequest) {
				code = 400
			} else if errors.Is(err, errHandshake) {
				code = 502
			}
			logf("connect %q failed", in.Name)
			fail(w, code, err.Error())
			return
		}
		logf("connect %q ok", in.Name)
		writeJSON(w, 200, s.status())
	})
	mux.HandleFunc("POST /disconnect", func(w http.ResponseWriter, r *http.Request) {
		s.disconnect()
		logf("disconnected")
		writeJSON(w, 200, s.status())
	})
	mux.HandleFunc("POST /mode", func(w http.ResponseWriter, r *http.Request) {
		var in struct{ Mode string }
		if !body(w, r, &in) {
			return
		}
		if in.Mode != "off" && in.Mode != "required" {
			fail(w, 400, `mode must be "off" or "required"`)
			return
		}
		if err := s.setMode(in.Mode); err != nil {
			fail(w, 500, err.Error())
			return
		}
		logf("mode=%s", in.Mode)
		writeJSON(w, 200, s.status())
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") || subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) != 1 {
			fail(w, 401, "unauthorized")
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func env(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func main() {
	addr := env("CONTROL_ADDR", ":8000")
	token := os.Getenv("VPN_CONTROL_TOKEN")
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		req, _ := http.NewRequest("GET", "http://127.0.0.1"+addr[strings.LastIndex(addr, ":"):]+"/status", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := (&http.Client{Timeout: 4 * time.Second}).Do(req)
		if err != nil || resp.StatusCode != 200 {
			os.Exit(1)
		}
		return
	}
	log.SetFlags(log.LstdFlags | log.LUTC)
	if token == "" {
		log.Fatal("VPN_CONTROL_TOKEN is required")
	}
	s := &Server{token: token, pubURL: env("PUBLIC_IP_URL", "https://api.ipify.org"), fallbackDNS: env("VPN_FALLBACK_DNS", "1.1.1.1")}
	for _, c := range strings.Split(env("LAN_CIDRS", "172.31.250.0/24"), ",") {
		p, err := netip.ParsePrefix(strings.TrimSpace(c))
		if err != nil || !p.Addr().Is4() {
			log.Fatalf("invalid LAN_CIDRS entry %q", c)
		}
		s.lan = append(s.lan, p.Masked())
	}
	s.webPorts = "8000, " + env("WEBUI_PORT", "8080")
	if n, err := strconv.Atoi(env("HANDSHAKE_TIMEOUT_SEC", "20")); err == nil && n > 0 {
		s.handshakeTimeout = time.Duration(n) * time.Second
	} else {
		s.handshakeTimeout = 20 * time.Second
	}
	mode := env("VPN_DEFAULT_MODE", "off")
	if mode != "off" && mode != "required" {
		log.Fatalf("VPN_DEFAULT_MODE must be off or required")
	}
	// Remember Docker's resolver config; heal a stale file left by a previous run.
	orig, _ := os.ReadFile("/etc/resolv.conf")
	s.origResolv = string(orig)
	if !strings.Contains(s.origResolv, "127.0.0.11") {
		s.origResolv = "nameserver 127.0.0.11\noptions ndots:0\n"
	}
	s.origNS = "127.0.0.11"
	// Install the firewall BEFORE the API (and qBittorrent, which waits for our healthcheck) come up.
	if err := applyRuleset(s.rules(mode)); err != nil {
		log.Fatalf("cannot install firewall: %v", err)
	}
	if mode == "required" {
		s.failClosedDNS()
	} else {
		s.openDNS()
	}
	s.mode = mode
	go s.publicIPLoop()
	logf("vpn control listening on %s (mode=%s, lan=%v)", addr, mode, s.lan)
	srv := &http.Server{Addr: addr, Handler: s.handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second}
	log.Fatal(srv.ListenAndServe())
}
