package main

import (
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
	r := buildRuleset("required", nil, nil, "8000, 8080")
	if !strings.Contains(r, "policy drop") || !strings.Contains(r, "meta nfproto ipv6") {
		t.Fatal(r)
	}
	if strings.Contains(buildRuleset("off", nil, nil, "8000"), "policy drop; \n    ip") {
		t.Fatal("off must not drop")
	}
}
