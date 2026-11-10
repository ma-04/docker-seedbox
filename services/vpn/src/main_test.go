package main

import (
	"fmt"
	"net/netip"
	"strings"
	"testing"
)

func TestResolveDefaultModeFailsClosed(t *testing.T) {
	for in, want := range map[string]string{"": "required", "  ": "required", "required": "required", "off": "off"} {
		got, err := resolveDefaultMode(in)
		if err != nil || got != want {
			t.Errorf("resolveDefaultMode(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	if _, err := resolveDefaultMode("on"); err == nil {
		t.Error("invalid mode accepted")
	}
}

func TestSetModeUnchangedIsNoop(t *testing.T) {
	for _, mode := range []string{"off", "required"} {
		s := &Server{mode: mode, iface: "wg0"}
		// Would execute `ip`/`nft` (and tear the tunnel down) if it did any work.
		if err := s.setMode(mode); err != nil {
			t.Fatalf("setMode(%s): %v", mode, err)
		}
		if s.iface != "wg0" {
			t.Errorf("tunnel was touched by a no-op setMode(%s)", mode)
		}
	}
}

func TestAllowedPrefixes(t *testing.T) {
	got := allowedPrefixes([]netip.Prefix{netip.MustParsePrefix("0.0.0.0/0"), netip.MustParsePrefix("10.0.0.0/8")})
	if strings.Join(got, ",") != "0.0.0.0/1,128.0.0.0/1,10.0.0.0/8" {
		t.Errorf("got %v", got)
	}
}

type fakeIP struct {
	routes map[string]string // prefix -> full route line
	failOn string            // prefix whose replace fails
}

func (f *fakeIP) run(_ string, name string, args ...string) (string, error) {
	if name != "ip" || len(args) < 3 {
		return "", nil
	}
	switch args[2] {
	case "show": // ip -4 route show exact X
		return f.routes[args[4]], nil
	case "replace":
		if args[3] == f.failOn {
			return "", fmt.Errorf("boom")
		}
		f.routes[args[3]] = args[3] + " " + strings.Join(args[4:], " ")
	case "del":
		delete(f.routes, args[3])
	}
	return "", nil
}

func TestSwapRoutesRollsBackOnFailure(t *testing.T) {
	f := &fakeIP{routes: map[string]string{
		"0.0.0.0/1":   "0.0.0.0/1 dev wg0 scope link",
		"128.0.0.0/1": "128.0.0.0/1 dev wg0 scope link",
	}, failOn: "10.0.0.0/8"}
	err := swapRoutes(f.run, []string{"0.0.0.0/1", "128.0.0.0/1", "10.0.0.0/8"}, "wg1")
	if err == nil {
		t.Fatal("expected an error")
	}
	if f.routes["0.0.0.0/1"] != "0.0.0.0/1 dev wg0 scope link" || f.routes["128.0.0.0/1"] != "128.0.0.0/1 dev wg0 scope link" {
		t.Errorf("old tunnel routes not restored: %v", f.routes)
	}
	if _, ok := f.routes["10.0.0.0/8"]; ok {
		t.Errorf("failed prefix left behind: %v", f.routes)
	}
}

func TestSwapRoutesDeletesPrefixesThatHadNoRoute(t *testing.T) {
	f := &fakeIP{routes: map[string]string{}, failOn: "128.0.0.0/1"}
	if err := swapRoutes(f.run, []string{"0.0.0.0/1", "128.0.0.0/1"}, "wg1"); err == nil {
		t.Fatal("expected an error")
	}
	if len(f.routes) != 0 {
		t.Errorf("routes should be empty after rollback: %v", f.routes)
	}
}

func TestSwapRoutesSuccess(t *testing.T) {
	f := &fakeIP{routes: map[string]string{}}
	if err := swapRoutes(f.run, []string{"0.0.0.0/1"}, "wg1"); err != nil {
		t.Fatal(err)
	}
	if f.routes["0.0.0.0/1"] == "" {
		t.Error("route not installed")
	}
}

func TestEndpointExceptionRequiresWireGuardFwmark(t *testing.T) {
	ep := netip.MustParseAddrPort("203.0.113.5:51820")
	r := buildRuleset("required", nil, []netip.AddrPort{ep}, "8000")
	want := "ip daddr 203.0.113.5 udp dport 51820 meta mark " + wgFwmark + " accept"
	if !strings.Contains(r, want) {
		t.Errorf("endpoint rule must be restricted to the wg fwmark; ruleset:\n%s", r)
	}
	if strings.Contains(r, "51820 accept") {
		t.Error("unconditional endpoint accept (any uid could use it)")
	}
}
