package main

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"testing"
)

func testPolicy() fwPolicy {
	return fwPolicy{lan: []netip.Prefix{netip.MustParsePrefix("172.31.250.0/24")}, webPort: "8080", controlPort: "8000"}
}

// chain returns the text of one chain of a ruleset.
func chain(t *testing.T, rules, name string) string {
	t.Helper()
	i := strings.Index(rules, "chain "+name+" {")
	if i < 0 {
		t.Fatalf("no chain %s in:\n%s", name, rules)
	}
	j := strings.Index(rules[i:], "\n  }")
	return rules[i : i+j]
}

// ruleLines returns the trimmed rule lines of a chain (without the header lines), in order.
func ruleLines(c string) []string {
	var out []string
	for _, l := range strings.Split(c, "\n")[2:] {
		out = append(out, strings.TrimSpace(l))
	}
	return out
}

func indexOf(ls []string, want string) int {
	for i, l := range ls {
		if l == want {
			return i
		}
	}
	return -1
}

func TestLANOutputIsRestrictedInEveryMode(t *testing.T) {
	ep := netip.MustParseAddrPort("203.0.113.5:51820")
	for _, mode := range []string{"required", "off"} {
		r := buildRuleset(mode, testPolicy(), []netip.AddrPort{ep}, nil)
		out := ruleLines(chain(t, r, "output"))
		est := indexOf(out, "ip daddr { 172.31.250.0/24 } ct state established,related accept")
		drop := indexOf(out, "ip daddr { 172.31.250.0/24 } drop")
		if est < 0 || drop < 0 || est > drop {
			t.Fatalf("%s: want established, then LAN drop (in that order); got %v", mode, out)
		}
		for _, l := range out {
			if strings.Contains(l, "skuid 0") && !strings.Contains(l, "127.0.0.11") {
				t.Errorf("%s: uid 0 must not be exempted from any rule except the Docker resolver drop: %s", mode, l)
			}
			if strings.Contains(l, "172.31.250.0/24") && strings.HasSuffix(l, " accept") && l != out[est] {
				t.Errorf("%s: unexpected LAN accept: %s", mode, l)
			}
			if l == "ct state established,related accept" {
				t.Errorf("%s: unscoped established accept on output (would survive a switch from off to required)", mode)
			}
		}
		if mode == "off" {
			if !strings.Contains(chain(t, r, "output"), "policy accept") {
				t.Error("off: internet-direct must stay allowed")
			}
			if strings.Contains(r, "203.0.113.5") || strings.Contains(r, `oifname "wg*" accept`) {
				t.Error("off: no tunnel rules expected")
			}
		} else {
			if !strings.Contains(chain(t, r, "output"), "policy drop") {
				t.Error("required: policy must be drop")
			}
			// WireGuard's own packets carry no socket owner: they must be accepted before the LAN drop.
			if e := indexOf(out, "ip daddr 203.0.113.5 udp dport 51820 meta mark "+wgFwmark+" accept"); e < 0 || e > drop {
				t.Error("endpoint accept must exist and come before the LAN drop")
			}
		}
	}
}

func TestLANInputOnlyWebUIAndControl(t *testing.T) {
	p := testPolicy()
	in := ruleLines(chain(t, buildRuleset("required", p, nil, nil), "input"))
	want := []string{
		`iifname "wg*" tcp dport { 8000, 8080 } drop`,
		`iifname "lo" accept`,
		`ct state established,related accept`,
		`ip saddr { 172.31.250.0/24 } tcp dport 8080 accept`,
		`ip saddr { 172.31.250.0/24 } tcp dport 8000 accept`,
		`ip saddr { 172.31.250.0/24 } drop`,
	}
	if strings.Join(in, "|") != strings.Join(want, "|") {
		t.Errorf("input chain:\n got %v\nwant %v", in, want)
	}
	p.controlFrom = []netip.Addr{netip.MustParseAddr("172.31.250.3"), netip.MustParseAddr("172.31.250.4")}
	in = ruleLines(chain(t, buildRuleset("off", p, nil, nil), "input"))
	if indexOf(in, "ip saddr { 172.31.250.3, 172.31.250.4 } tcp dport 8000 accept") < 0 || indexOf(in, "ip saddr { 172.31.250.0/24 } tcp dport 8000 accept") >= 0 {
		t.Errorf("control port must be limited to CONTROL_TRUSTED_IPS: %v", in)
	}
}

func TestAllowOutIsExplicitAndScoped(t *testing.T) {
	r := buildRuleset("required", testPolicy(), nil, nil)
	if strings.Contains(r, "th dport") {
		t.Error("no allow-out rules expected by default")
	}
	ao, err := parseAllowOut("172.31.250.30:6969, 172.31.250.31")
	if err != nil || len(ao) != 2 {
		t.Fatalf("%v %v", ao, err)
	}
	p := testPolicy()
	p.allowOut = ao
	r = buildRuleset("required", p, nil, nil)
	out := ruleLines(chain(t, r, "output"))
	a := indexOf(out, "ip daddr 172.31.250.30 meta l4proto { tcp, udp } th dport 6969 accept")
	b := indexOf(out, "ip daddr 172.31.250.31 accept")
	drop := indexOf(out, "ip daddr { 172.31.250.0/24 } drop")
	if a < 0 || b < 0 || a > drop || b > drop {
		t.Errorf("allow-out rules must exist and precede the LAN drop: %v", out)
	}
	if indexOf(ruleLines(chain(t, r, "input")), "ip saddr 172.31.250.31 accept") < 0 {
		t.Error("allow-listed hosts may dial in")
	}
	for _, bad := range []string{"nope", "::1", "172.31.250.30:0", "172.31.250.30:99999", "172.31.250.0/24"} {
		if _, err := parseAllowOut(bad); err == nil {
			t.Errorf("parseAllowOut(%q) accepted", bad)
		}
	}
	if ao, err := parseAllowOut(""); err != nil || len(ao) != 0 {
		t.Error("empty must mean none")
	}
}

func TestParseControlTrusted(t *testing.T) {
	if got, err := parseControlTrusted("172.31.250.3, 172.31.250.4"); err != nil || len(got) != 2 {
		t.Fatalf("%v %v", got, err)
	}
	for _, bad := range []string{"x", "fe80::1", "172.31.250.0/24"} {
		if _, err := parseControlTrusted(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestConnectRefusedWhileModeOff(t *testing.T) {
	// Would execute `ip` (and fail) if the refusal came after any work.
	s := &Server{mode: "off", token: "t"}
	err := s.connect("x", &WGConfig{EndpointHost: "192.0.2.1", EndpointPort: 51820})
	if !errors.Is(err, errModeOff) {
		t.Fatalf("got %v, want errModeOff", err)
	}
	if code, _ := publicError(err); code != 409 {
		t.Errorf("status %d, want 409", code)
	}
	req := httptest.NewRequest("POST", "/connect", strings.NewReader(`{"name":"x","config":`+strconv.Quote(cfg("", "0.0.0.0/0"))+`}`))
	req.Header.Set("Authorization", "Bearer t")
	rec := httptest.NewRecorder()
	s.handler().ServeHTTP(rec, req)
	if rec.Code != 409 {
		t.Errorf("POST /connect in off mode: %d %s, want 409", rec.Code, rec.Body)
	}
}

func TestPublicErrorHidesCommandOutput(t *testing.T) {
	secret := "PrivateKey=SECRETSECRETSECRETSECRETSECRETSECRETSECR="
	for _, err := range []error{
		fmt.Errorf("ip link: exit status 2: %s", secret),
		fmt.Errorf("nft: boom: %s", secret),
		errWireGuard,
	} {
		code, msg := publicError(err)
		if code != 500 || strings.Contains(msg, "SECRET") || strings.Contains(msg, "exit status") {
			t.Errorf("%v -> %d %q", err, code, msg)
		}
	}
	if code, _ := publicError(fmt.Errorf("%w: no handshake", errHandshake)); code != 502 {
		t.Error("handshake failures stay 502")
	}
	if code, _ := publicError(fmt.Errorf("%w: cannot resolve endpoint host", errBadRequest)); code != 400 {
		t.Error("bad requests stay 400")
	}
}

func TestWgSetConfDoesNotLeakWgOutput(t *testing.T) {
	old := wgRun
	defer func() { wgRun = old }()
	wgRun = func(stdin, name string, args ...string) (string, error) {
		// what `wg setconf` does on a parse error: print the offending line (key material)
		line := strings.Split(stdin, "\n")[1]
		return "Line unrecognized: `" + line + "'", fmt.Errorf("wg setconf: exit status 1: Line unrecognized: `%s'", line)
	}
	c, err := ParseWGConfig(cfg("", "0.0.0.0/0"))
	if err != nil {
		t.Fatal(err)
	}
	c.PrivateKey = "SECRETSECRETSECRETSECRETSECRETSECRETSECRET1="
	err = wgSetConf("wg0", c, netip.MustParseAddrPort("192.0.2.1:51820"))
	if !errors.Is(err, errWireGuard) || strings.Contains(err.Error(), "SECRET") {
		t.Fatalf("wg output leaked: %v", err)
	}
	if _, msg := publicError(err); strings.Contains(msg, "SECRET") {
		t.Fatalf("leaked in HTTP body: %q", msg)
	}
}

func TestKeyValidationIsStrict(t *testing.T) {
	good := "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
	if !validKey(good) {
		t.Fatal("valid key rejected")
	}
	cr := "AAAAAAAAAAAAAAAAAAAAAA\rAAAAAAAAAAAAAAAAAAAA="
	for name, bad := range map[string]string{
		"CR inside":      cr,
		"LF inside":      strings.Replace(cr, "\r", "\n", 1),
		"trailing CR":    good + "\r",
		"space inside":   strings.Replace(cr, "\r", " ", 1),
		"no padding":     "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"too short":      "AAAA=",
		"url-safe alpha": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-=",
		"empty":          "",
	} {
		if validKey(bad) {
			t.Errorf("%s accepted: %q", name, bad)
		}
	}
	base := "[Interface]\nPrivateKey = %s\nAddress = 10.0.0.2/32\n[Peer]\nPublicKey = %s\nAllowedIPs = 0.0.0.0/0\nEndpoint = 192.0.2.1:51820\n"
	for name, text := range map[string]string{
		"PrivateKey":   fmt.Sprintf(base, cr, good),
		"PublicKey":    fmt.Sprintf(base, good, cr),
		"PresharedKey": fmt.Sprintf(base, good, good) + "PresharedKey = " + cr + "\n",
	} {
		if _, err := ParseWGConfig(text); err == nil {
			t.Errorf("%s with an embedded CR accepted", name)
		}
	}
	if _, err := ParseWGConfig(fmt.Sprintf(base, good, good) + "PresharedKey = " + good + "\n"); err != nil {
		t.Errorf("valid config rejected: %v", err)
	}
}

// There is no uid exemption any more: root inside the qbittorrent container (same namespace) must not be able to reach
// the LAN either, so a root compromise there is not a way past the firewall.
func TestNoUidExemptionForTheLAN(t *testing.T) {
	for _, mode := range []string{"required", "off"} {
		r := buildRuleset(mode, testPolicy(), nil, nil)
		if strings.Contains(r, "skuid 0 accept") {
			t.Errorf("%s: root exempted from a drop:\n%s", mode, r)
		}
	}
}

func TestPrivateRangesAreDroppedInEveryMode(t *testing.T) {
	want := []string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "127.0.0.0/8", "224.0.0.0/4", "240.0.0.0/4"}
	dnsAddr := netip.MustParseAddr("10.2.0.1")
	for _, mode := range []string{"required", "off"} {
		r := buildRuleset(mode, testPolicy(), nil, []netip.Addr{dnsAddr})
		out := ruleLines(chain(t, r, "output"))
		var drop string
		for _, l := range out {
			if strings.HasPrefix(l, "ip daddr { 0.0.0.0/8") && strings.HasSuffix(l, " drop") {
				drop = l
			}
		}
		if drop == "" {
			t.Fatalf("%s: no private-range drop in %v", mode, out)
		}
		for _, w := range want {
			if !strings.Contains(drop, w) {
				t.Errorf("%s: %s missing from the drop set", mode, w)
			}
		}
		// the drop is not keyed on an interface or uid: root and qBittorrent, via any non-lo interface
		if strings.Contains(drop, "oifname") || strings.Contains(drop, "skuid") {
			t.Errorf("%s: private drop must not be interface/uid scoped: %s", mode, drop)
		}
		di, lo := indexOf(out, drop), indexOf(out, `oifname "lo" accept`)
		if lo < 0 || lo > di {
			t.Errorf("%s: only the lo device may be accepted before the private drop", mode)
		}
		// IPv6 is dropped in both modes
		if indexOf(out, `meta nfproto ipv6 oifname != "lo" drop`) < 0 {
			t.Errorf("%s: IPv6 must be dropped", mode)
		}
		// the tunnel DNS exception exists only in required mode, only through wg*, only for port 53, before the drop
		dnsRule := `oifname "wg*" ip daddr { 10.2.0.1 } meta l4proto { tcp, udp } th dport 53 accept`
		if mode == "required" {
			if i := indexOf(out, dnsRule); i < 0 || i > di {
				t.Errorf("required: DNS exception missing or after the drop: %v", out)
			}
			if !(indexOf(out, `oifname "wg*" accept`) > di) {
				t.Error("required: the blanket wg accept must come after the private drop (private destinations via wg are dropped)")
			}
		} else {
			if strings.Contains(r, "10.2.0.1") {
				t.Error("off: no tunnel DNS rule expected")
			}
			if !strings.Contains(chain(t, r, "output"), "policy accept") {
				t.Error("off: public internet stays reachable")
			}
		}
	}
}

func TestEndpointAndEstablishedComeBeforeThePrivateDrop(t *testing.T) {
	// a VPN endpoint on a private address (lab setups) and the api/worker replies must still work
	ep := netip.MustParseAddrPort("10.9.9.9:51820")
	out := ruleLines(chain(t, buildRuleset("required", testPolicy(), []netip.AddrPort{ep}, nil), "output"))
	drop := indexOf(out, "ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/4, 240.0.0.0/4 } drop")
	e := indexOf(out, "ip daddr 10.9.9.9 udp dport 51820 meta mark "+wgFwmark+" accept")
	est := indexOf(out, "ip daddr { 172.31.250.0/24 } ct state established,related accept")
	if drop < 0 || e < 0 || est < 0 || e > drop || est > drop {
		t.Errorf("order wrong: %v", out)
	}
}

// Documentation ranges are the fake internet of the hermetic test stacks; they must stay reachable.
func TestDocumentationRangesAreNotBlocked(t *testing.T) {
	for _, p := range []string{"192.0.2.", "198.51.100.", "203.0.113."} {
		if strings.Contains(strings.Join(blockedV4, " "), p) {
			t.Errorf("%s* must not be blocked", p)
		}
	}
	for _, p := range blockedV4 {
		if _, err := netip.ParsePrefix(p); err != nil {
			t.Errorf("bad prefix %q", p)
		}
	}
}

func TestTunnelDNSSelection(t *testing.T) {
	s := &Server{fallbackDNS: "1.1.1.1"}
	cfg := &WGConfig{DNS: []netip.Addr{netip.MustParseAddr("10.2.0.1")}}
	if got := s.tunnelDNS(cfg); len(got) != 1 || got[0].String() != "10.2.0.1" {
		t.Errorf("got %v", got)
	}
	if got := s.tunnelDNS(&WGConfig{}); len(got) != 1 || got[0].String() != "1.1.1.1" {
		t.Errorf("fallback: got %v", got)
	}
	if got := (&Server{fallbackDNS: "dns.example"}).tunnelDNS(&WGConfig{}); got != nil {
		t.Errorf("hostname fallback must not produce rules: %v", got)
	}
}

func TestRulesUseTheDNSOfTheTunnelThatIsUp(t *testing.T) {
	s := &Server{fw: testPolicy()}
	if strings.Contains(s.rules("required"), "th dport 53") {
		t.Error("no tunnel, no DNS exception")
	}
	s.dns = []netip.Addr{netip.MustParseAddr("10.99.1.1")}
	if !strings.Contains(s.rules("required"), "{ 10.99.1.1 } meta l4proto { tcp, udp } th dport 53 accept") {
		t.Error("DNS of the tunnel that is up must be reachable via wg*")
	}
}

func TestSearchPortOnlyFromTrustedAndLocalOnlyPorts(t *testing.T) {
	p := testPolicy()
	p.searchPort = "9117"
	p.localOnly = []string{"8191"}
	p.allowOut = []allowOut{{addr: netip.MustParseAddr("172.31.250.31")}}
	for _, mode := range []string{"required", "off"} {
		// No trusted source: the search port is closed like the loopback-only ones.
		in := ruleLines(chain(t, buildRuleset(mode, p, nil, nil), "input"))
		drop := indexOf(in, "tcp dport { 9117, 8191 } drop")
		if drop < 0 {
			t.Fatalf("%s: search + local-only ports must be dropped: %v", mode, in)
		}
		for i, l := range in {
			if strings.Contains(l, "9117") && strings.HasSuffix(l, "accept") {
				t.Errorf("%s: no search accept expected without SEARCH_TRUSTED_IPS: %s", mode, l)
			}
			// Every LAN accept (WebUI, control, allow-listed fixtures dialling in) comes after the drop.
			if strings.HasPrefix(l, "ip saddr") && strings.HasSuffix(l, "accept") && i < drop {
				t.Errorf("%s: %q precedes the search/local-only drop", mode, l)
			}
			if strings.Contains(l, "8191") && l != in[drop] {
				t.Errorf("%s: the local-only port must appear in the drop only: %s", mode, l)
			}
		}
		if lo := indexOf(in, `iifname "lo" accept`); lo < 0 || lo > drop {
			t.Errorf("%s: loopback must be accepted before the drop (Jackett -> FlareSolverr on 127.0.0.1)", mode)
		}

		p2 := p
		p2.searchFrom = []netip.Addr{netip.MustParseAddr("172.31.250.3")}
		in = ruleLines(chain(t, buildRuleset(mode, p2, nil, nil), "input"))
		acc := indexOf(in, `iifname != "wg*" ip saddr { 172.31.250.3 } tcp dport 9117 accept`)
		drop = indexOf(in, "tcp dport { 9117, 8191 } drop")
		if acc < 0 || drop < 0 || acc > drop {
			t.Errorf("%s: want the api's search accept (never via the tunnel), then the drop: %v", mode, in)
		}
	}
	// Empty LAN (no LAN_CIDRS) still closes the ports.
	p.lan = nil
	if indexOf(ruleLines(chain(t, buildRuleset("off", p, nil, nil), "input")), "tcp dport { 9117, 8191 } drop") < 0 {
		t.Error("ports must be closed without a LAN too")
	}
}

func TestLoopbackIsScopedByUid(t *testing.T) {
	p := testPolicy()
	p.searchPort, p.localOnly, p.searchUID = "9117", []string{"8191"}, "1001"
	for _, mode := range []string{"required", "off"} {
		out := ruleLines(chain(t, buildRuleset(mode, p, nil, nil), "output"))
		lo := indexOf(out, `oifname "lo" accept`)
		want := []string{
			`oifname "lo" tcp dport 8000 meta skuid != 0 drop`,
			`oifname "lo" tcp dport { 9117, 8191 } meta skuid != { 0, 1001 } drop`,
			`oifname "lo" tcp dport 8080 meta skuid 1001 drop`,
		}
		for _, w := range want {
			if i := indexOf(out, w); i < 0 || i > lo {
				t.Errorf("%s: %q must exist and precede the loopback accept: %v", mode, w, out)
			}
		}
	}
	// Without a search uid only the control port is restricted (root only) and the search ports are root-only.
	p.searchUID = ""
	out := ruleLines(chain(t, buildRuleset("off", p, nil, nil), "output"))
	if indexOf(out, `oifname "lo" tcp dport { 9117, 8191 } meta skuid != { 0 } drop`) < 0 || strings.Contains(strings.Join(out, "|"), "skuid 1001") {
		t.Errorf("no search uid: search ports root-only, no uid-specific rules: %v", out)
	}
}

func TestParsePorts(t *testing.T) {
	if got, err := parsePorts("X", " 8191, 9000 "); err != nil || strings.Join(got, ",") != "8191,9000" {
		t.Errorf("got %v %v", got, err)
	}
	for _, bad := range []string{"0", "65536", "abc", "80;drop", "1 2"} {
		if _, err := parsePorts("X", bad); err == nil {
			t.Errorf("parsePorts(%q) accepted", bad)
		}
	}
	if got, err := parsePorts("X", ""); err != nil || len(got) != 0 {
		t.Error("empty must mean none")
	}
}

func TestCompanionProbeIsFixedAndLoopbackOnly(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			_, _ = w.Write([]byte(`{"status":"ok"}`))
			return
		}
		http.Redirect(w, r, "/health", http.StatusFound)
	}))
	defer up.Close()
	s := &Server{}
	if !strings.HasPrefix(up.URL, "http://127.0.0.1:") || !s.probeLocal(up.URL+"/health") {
		t.Fatalf("a healthy loopback service must report true (%s)", up.URL)
	}
	if s.probeLocal(up.URL + "/other") {
		t.Error("redirects are not followed: only a direct 200 counts")
	}
	if s.probeLocal("http://example.com:8191/health") || s.probeLocal("") {
		t.Error("non-loopback URLs must never be probed")
	}
	if s.probeLocal("http://127.0.0.1:1/health") {
		t.Error("closed port must report false")
	}
}
