package main

import (
	"errors"
	"fmt"
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
		r := buildRuleset(mode, testPolicy(), []netip.AddrPort{ep})
		out := ruleLines(chain(t, r, "output"))
		est := indexOf(out, "ip daddr { 172.31.250.0/24 } ct state established,related accept")
		root := indexOf(out, "ip daddr { 172.31.250.0/24 } meta skuid 0 accept")
		drop := indexOf(out, "ip daddr { 172.31.250.0/24 } drop")
		if est < 0 || root < 0 || drop < 0 || !(est < root && root < drop) {
			t.Fatalf("%s: want established, uid 0, then LAN drop (in that order); got %v", mode, out)
		}
		for _, l := range out {
			if strings.Contains(l, "172.31.250.0/24") && strings.HasSuffix(l, " accept") && l != out[est] && l != out[root] {
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
	in := ruleLines(chain(t, buildRuleset("required", p, nil), "input"))
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
	in = ruleLines(chain(t, buildRuleset("off", p, nil), "input"))
	if indexOf(in, "ip saddr { 172.31.250.3, 172.31.250.4 } tcp dport 8000 accept") < 0 || indexOf(in, "ip saddr { 172.31.250.0/24 } tcp dport 8000 accept") >= 0 {
		t.Errorf("control port must be limited to CONTROL_TRUSTED_IPS: %v", in)
	}
}

func TestAllowOutIsExplicitAndScoped(t *testing.T) {
	r := buildRuleset("required", testPolicy(), nil)
	if strings.Contains(r, "th dport") {
		t.Error("no allow-out rules expected by default")
	}
	ao, err := parseAllowOut("172.31.250.30:6969, 172.31.250.31")
	if err != nil || len(ao) != 2 {
		t.Fatalf("%v %v", ao, err)
	}
	p := testPolicy()
	p.allowOut = ao
	r = buildRuleset("required", p, nil)
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
