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
	token, pubURL, fallbackDNS string
	lan                        []netip.Prefix
	fw                         fwPolicy
	envMTU                     int // VPN_MTU, 0 = unset
	handshakeTimeout           time.Duration
	origNS, origResolv         string

	opMu sync.Mutex // serialises mutating operations

	mu       sync.Mutex // guards the fields below
	mode     string
	iface    string
	name     string
	since    int64
	endpoint netip.AddrPort
	dns      []netip.Addr // DNS servers of the tunnel that is up (the only private addresses reachable through wg*)
	mtu      int
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
	MTU              *int    `json:"mtu"`
}

func (s *Server) status() statusDTO {
	s.mu.Lock()
	mode, iface, name, since, ip, mtu := s.mode, s.iface, s.name, s.since, s.pubIP, s.mtu
	s.mu.Unlock()
	d := statusDTO{Mode: mode}
	if iface == "" {
		return d
	}
	d.Name, d.Since, d.MTU = &name, &since, &mtu
	if age, ok := handshakeAge(iface); ok {
		d.LastHandshakeSec = &age
		d.Connected = age <= 180
	}
	if d.Connected && ip != "" {
		d.PublicIP = &ip
	}
	return d
}

var (
	errBadRequest = errors.New("bad request")
	// errModeOff: /connect is refused while the mode is off. The worker could otherwise race an admin switching to off
	// and bring a tunnel up in a mode that is supposed to have none.
	errModeOff = errors.New("vpn mode is off")
)

// rules renders the ruleset for the tunnel that is currently up (its DNS servers are the only private addresses reachable via wg*).
func (s *Server) rules(mode string, eps ...netip.AddrPort) string {
	s.mu.Lock()
	dns := s.dns
	s.mu.Unlock()
	return buildRuleset(mode, s.fw, eps, dns)
}

// tunnelDNS: the resolvers /etc/resolv.conf will point at for cfg (its DNS= servers, else VPN_FALLBACK_DNS).
func (s *Server) tunnelDNS(cfg *WGConfig) []netip.Addr {
	if len(cfg.DNS) > 0 {
		return cfg.DNS
	}
	if a, err := netip.ParseAddr(s.fallbackDNS); err == nil && a.Is4() {
		return []netip.Addr{a}
	}
	return nil
}

func (s *Server) failClosedDNS() { writeResolv("# vpn: no tunnel up, DNS disabled (kill switch)\n") }
func (s *Server) openDNS()       { writeResolv(s.origResolv) }

func (s *Server) connect(name string, cfg *WGConfig) (err error) {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	// Checked under opMu (setMode holds it too), before anything touches the system: the mode cannot change between
	// this check and the tunnel being up.
	s.mu.Lock()
	off := s.mode == "off"
	s.mu.Unlock()
	if off {
		return errModeOff
	}
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
	newDNS := s.tunnelDNS(cfg)
	if mode == "required" {
		// The new tunnel's DNS servers are reachable before resolv.conf is switched; the old ones until the old tunnel is gone.
		s.mu.Lock()
		both := append(append([]netip.Addr{}, s.dns...), newDNS...)
		s.mu.Unlock()
		if err := applyRuleset(buildRuleset("required", s.fw, eps, both)); err != nil {
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
	mtu := resolveMTU(cfg.MTU, s.envMTU)
	if _, err = run("", "ip", "link", "set", newIf, "mtu", strconv.Itoa(mtu), "up"); err != nil {
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
	// If any replace fails, the routes already moved are restored so the old tunnel is not left routeless.
	if err = swapRoutes(run, allowedPrefixes(cfg.AllowedIPs), newIf); err != nil {
		return fail(err)
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
	s.iface, s.name, s.since, s.endpoint, s.mtu = newIf, name, time.Now().Unix(), ep, mtu
	s.dns = newDNS
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

// runFn is the signature of run(); swapRoutes takes it so the rollback can be tested.
type runFn func(stdin string, name string, args ...string) (string, error)

// allowedPrefixes expands AllowedIPs like wg-quick: a default route becomes two /1 routes.
func allowedPrefixes(ips []netip.Prefix) []string {
	var out []string
	for _, p := range ips {
		if p.Bits() == 0 {
			out = append(out, "0.0.0.0/1", "128.0.0.0/1")
		} else {
			out = append(out, p.String())
		}
	}
	return out
}

// swapRoutes points every prefix at newIf. Before touching a prefix its current route is
// recorded; when a later `ip route replace` fails, every prefix already moved is put back
// (or deleted if it had no route), so the previous tunnel keeps carrying traffic.
func swapRoutes(run runFn, prefixes []string, newIf string) error {
	type saved struct{ prefix, route string }
	var done []saved
	for _, x := range prefixes {
		prev, _ := run("", "ip", "-4", "route", "show", "exact", x)
		if _, err := run("", "ip", "-4", "route", "replace", x, "dev", newIf); err != nil {
			for i := len(done) - 1; i >= 0; i-- {
				d := done[i]
				if d.route == "" {
					_, _ = run("", "ip", "-4", "route", "del", d.prefix, "dev", newIf)
				} else {
					_, _ = run("", "ip", append([]string{"-4", "route", "replace"}, strings.Fields(d.route)...)...)
				}
			}
			return err
		}
		done = append(done, saved{x, firstLine(prev)})
	}
	return nil
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return strings.TrimSpace(s)
}

// resolveDefaultMode validates VPN_DEFAULT_MODE. Unset means "required" (fail closed): after a
// host or container restart qBittorrent resumes torrents immediately, long before the worker
// has re-applied the admin's setting, so the safe default must not leak the real IP.
func resolveDefaultMode(v string) (string, error) {
	switch strings.TrimSpace(v) {
	case "":
		return "required", nil
	case "off", "required":
		return strings.TrimSpace(v), nil
	}
	return "", errors.New("VPN_DEFAULT_MODE must be off or required")
}

var (
	errHandshake = errors.New("handshake failed")
	errWireGuard = errors.New("wireguard configuration failed")
)

// teardown removes the tunnel (if any). The caller holds opMu.
func (s *Server) teardown() {
	s.mu.Lock()
	iface, ep := s.iface, s.endpoint
	s.iface, s.name, s.since, s.pubIP, s.mtu = "", "", 0, "", 0
	s.dns = nil
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
	if cur == mode {
		return nil // the worker re-asserts the mode regularly; an unchanged mode must not touch the tunnel or the firewall
	}
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
		s.teardown() // off = normal container route; the tunnel goes away
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

// publicError maps an internal error to the status code and the message that may go into an HTTP body. Only errors
// built from validated input or fixed text are passed through; everything else (command output from `ip`, `nft`
// or `wg`, which can echo configuration) is reduced to a generic message and stays out of the response.
func publicError(err error) (int, string) {
	switch {
	case errors.Is(err, errModeOff):
		return 409, "VPN mode is off: set it to required before connecting"
	case errors.Is(err, errBadRequest):
		return 400, err.Error()
	case errors.Is(err, errHandshake):
		return 502, err.Error()
	case errors.Is(err, errWireGuard):
		return 500, "WireGuard rejected the configuration"
	}
	return 500, "internal error (see the vpn container log)"
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
			code, msg := publicError(err)
			// The log gets the real cause (ip/nft output; wgSetConf already reduced wg failures to a generic error);
			// the HTTP body only the public message.
			logf("connect %q failed (%d: %s): %v", in.Name, code, msg, err)
			fail(w, code, msg)
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
			logf("mode %s failed: %v", in.Mode, err)
			fail(w, 500, "internal error (see the vpn container log)")
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
	var err error
	s := &Server{token: token, pubURL: env("PUBLIC_IP_URL", "https://api.ipify.org"), fallbackDNS: env("VPN_FALLBACK_DNS", "1.1.1.1")}
	for _, c := range strings.Split(env("LAN_CIDRS", "172.31.250.0/24"), ",") {
		p, err := netip.ParsePrefix(strings.TrimSpace(c))
		if err != nil || !p.Addr().Is4() {
			log.Fatalf("invalid LAN_CIDRS entry %q", c)
		}
		s.lan = append(s.lan, p.Masked())
	}
	if s.envMTU, err = parseMTUEnv(os.Getenv("VPN_MTU")); err != nil {
		log.Fatal(err)
	}
	controlPort := addr[strings.LastIndex(addr, ":")+1:]
	if n, err := strconv.Atoi(controlPort); err != nil || n < 1 || n > 65535 {
		log.Fatalf("invalid CONTROL_ADDR %q", addr)
	}
	webPort := env("WEBUI_PORT", "8080")
	if n, err := strconv.Atoi(webPort); err != nil || n < 1 || n > 65535 {
		log.Fatalf("invalid WEBUI_PORT %q", webPort)
	}
	controlFrom, err := parseControlTrusted(os.Getenv("CONTROL_TRUSTED_IPS"))
	if err != nil {
		log.Fatal(err)
	}
	// VPN_LAN_ALLOW_OUT is for the hermetic test fixtures only (e2e tracker/seeder, services/vpn/test): it lets
	// qBittorrent open connections to the listed LAN addresses. Never set it on a real deployment.
	allowOuts, err := parseAllowOut(os.Getenv("VPN_LAN_ALLOW_OUT"))
	if err != nil {
		log.Fatal(err)
	}
	s.fw = fwPolicy{lan: s.lan, webPort: webPort, controlPort: controlPort, controlFrom: controlFrom, allowOut: allowOuts}
	if len(allowOuts) > 0 {
		logf("WARNING: VPN_LAN_ALLOW_OUT is set (%d entries): qBittorrent may reach those LAN addresses. Test setups only.", len(allowOuts))
	}
	if n, err := strconv.Atoi(env("HANDSHAKE_TIMEOUT_SEC", "20")); err == nil && n > 0 {
		s.handshakeTimeout = time.Duration(n) * time.Second
	} else {
		s.handshakeTimeout = 20 * time.Second
	}
	mode, err := resolveDefaultMode(os.Getenv("VPN_DEFAULT_MODE"))
	if err != nil {
		log.Fatal(err)
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
	logf("vpn control listening on %s (mode=%s, lan=%v, default mtu=%d)", addr, mode, s.lan, resolveMTU(0, s.envMTU))
	srv := &http.Server{Addr: addr, Handler: s.handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second}
	log.Fatal(srv.ListenAndServe())
}
