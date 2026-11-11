package main

import (
	"strconv"
	"strings"
	"testing"
)

const k = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

func cfg(extraIf, peerAllowed string) string {
	return "[Interface]\nPrivateKey = " + k + "\nAddress = 10.0.0.2/32, fd00::2/128\nDNS = 10.0.0.1, 2606::1, example.com\n" + extraIf +
		"\n[Peer]\nPublicKey = " + k + "\nAllowedIPs = " + peerAllowed + "\nEndpoint = vpn.example.com:51820\n"
}

func TestParseOK(t *testing.T) {
	c, err := ParseWGConfig(cfg("", "0.0.0.0/0, ::/0"))
	if err != nil {
		t.Fatal(err)
	}
	if len(c.AllowedIPs) != 1 || len(c.Addresses) != 1 || len(c.DNS) != 1 || c.EndpointHost != "vpn.example.com" {
		t.Fatalf("%+v", c)
	}
}

func TestRejectHooks(t *testing.T) {
	for _, h := range []string{"PostUp", "preup", "PreDown", "POSTDOWN", "SaveConfig"} {
		if _, err := ParseWGConfig(cfg(h+" = touch /pwned\n", "0.0.0.0/0")); err == nil || !strings.Contains(err.Error(), "not allowed") {
			t.Fatalf("%s accepted: %v", h, err)
		}
	}
}

func TestRejectBad(t *testing.T) {
	if _, err := ParseWGConfig(cfg("", "::/0")); err == nil {
		t.Fatal("v6-only AllowedIPs accepted")
	}
	if _, err := ParseWGConfig(cfg("", "0.0.0.0/0") + "[Peer]\nPublicKey = " + k + "\n"); err == nil {
		t.Fatal("two peers accepted")
	}
	if _, err := ParseWGConfig(strings.Replace(cfg("", "0.0.0.0/0"), k, "short", 1)); err == nil {
		t.Fatal("bad key accepted")
	}
}

func TestRuleset(t *testing.T) {
	r := buildRuleset("required", testPolicy(), nil, nil)
	if !strings.Contains(r, "policy drop") || !strings.Contains(r, "meta nfproto ipv6") {
		t.Fatal(r)
	}
	if strings.Contains(buildRuleset("off", testPolicy(), nil, nil), "policy drop; \n    ip") {
		t.Fatal("off must not drop")
	}
}

func TestConfigMTU(t *testing.T) {
	c, err := ParseWGConfig(cfg("", "0.0.0.0/0"))
	if err != nil || c.MTU != 0 {
		t.Fatalf("unset MTU must stay 0: %v %+v", err, c)
	}
	for _, ok := range []string{"576", "1280", "1500"} {
		c, err := ParseWGConfig(cfg("MTU = "+ok+"\n", "0.0.0.0/0"))
		if err != nil || strconv.Itoa(c.MTU) != ok {
			t.Fatalf("MTU %s: %v", ok, err)
		}
	}
	for _, bad := range []string{"575", "1501", "0", "-1", "abc", ""} {
		if _, err := ParseWGConfig(cfg("MTU = "+bad+"\n", "0.0.0.0/0")); err == nil {
			t.Fatalf("MTU %q accepted", bad)
		}
	}
}

func TestParseMTUEnv(t *testing.T) {
	for in, want := range map[string]int{"": 0, " ": 0, "1380": 1380, " 576 ": 576, "1500": 1500} {
		if got, err := parseMTUEnv(in); err != nil || got != want {
			t.Fatalf("%q: %d %v", in, got, err)
		}
	}
	for _, bad := range []string{"575", "1501", "x", "1280.5", "-5"} {
		if _, err := parseMTUEnv(bad); err == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
}

func TestResolveMTUPrecedence(t *testing.T) {
	cases := []struct{ cfg, env, want int }{
		{0, 0, 1280}, {0, 1380, 1380}, {1420, 0, 1420}, {1400, 1380, 1400},
	}
	for _, c := range cases {
		if got := resolveMTU(c.cfg, c.env); got != c.want {
			t.Fatalf("%+v: got %d", c, got)
		}
	}
}

func TestRulesetMSSClamp(t *testing.T) {
	for _, mode := range []string{"required", "off"} {
		r := buildRuleset(mode, testPolicy(), nil, nil)
		if !strings.Contains(r, `oifname "wg*" tcp flags syn tcp option maxseg size set rt mtu`) {
			t.Fatalf("%s: no MSS clamp\n%s", mode, r)
		}
	}
	// the clamp must not add any accept to the kill-switch output chain
	r := buildRuleset("required", testPolicy(), nil, nil)
	out := r[strings.Index(r, "chain output"):]
	if strings.Contains(out, "maxseg") {
		t.Fatal("clamp leaked into output chain")
	}
}
