package main

import (
	"bytes"
	"context"
	"fmt"
	"net/netip"
	"os/exec"
	"strings"
	"time"
)

// The firewall is a single nftables table owned by this process. It is replaced
// atomically (one `nft -f` transaction), so there is never a moment with no rules
// while switching tunnels. Docker's own iptables rules (embedded DNS DNAT) are not
// touched.
//
// required: OUTPUT policy drop; allowed = loopback, wg interfaces, the UDP endpoint(s) of the tunnel being
//
//	brought up / currently up (only for packets carrying wgFwmark, WireGuard's own), and towards
//	LAN_CIDRS only replies (ct established/related) and uid 0 (this sidecar); see buildRuleset.
//	IPv6 (except loopback) is dropped. Docker's embedded resolver (127.0.0.11,
//	which forwards from the host side) is usable by root only (this process,
//	to resolve a WireGuard endpoint hostname) and never by qBittorrent.
//
// off:      OUTPUT policy accept, except the same LAN restriction as in required (internet-direct stays allowed).
// both:     INPUT from the tunnel to the control/WebUI ports is dropped, so other
//
//	customers of the VPN provider cannot reach them via the tunnel address; INPUT from the LAN is
//	limited to the WebUI and control ports.
//
// wgFwmark is set on every WireGuard interface (`FwMark` in the wg conf). The kernel stamps it on the OUTER
// (encrypted) UDP packets of the tunnel, and only those: they are kernel-originated, carry no socket owner (so
// `meta skuid` cannot tell them apart from nothing) and qBittorrent (uid 1000, no CAP_NET_ADMIN) cannot set
// SO_MARK. The endpoint exception below matches this mark, so a torrent peer/tracker/DHT node that happens to
// share the endpoint's IP:port gets no direct, cleartext path from the real address.
const wgFwmark = "0x5b76"

// allowOut is one VPN_LAN_ALLOW_OUT entry: a LAN address qBittorrent (any uid) may initiate connections to,
// optionally restricted to one port (tcp and udp). Test fixtures only; see parseAllowOut.
type allowOut struct {
	addr netip.Addr
	port uint16 // 0 = every port
}

// fwPolicy is everything buildRuleset needs besides the mode and the tunnel endpoints.
type fwPolicy struct {
	lan         []netip.Prefix
	webPort     string       // qBittorrent WebUI port (open to the whole LAN)
	controlPort string       // control API port
	controlFrom []netip.Addr // sources allowed to reach the control API; empty = the whole LAN (the token is still required)
	allowOut    []allowOut   // test-only LAN exceptions for non-root uids
}

func prefixList(lan []netip.Prefix) string {
	var s []string
	for _, p := range lan {
		s = append(s, p.String())
	}
	return strings.Join(s, ", ")
}

func addrList(a []netip.Addr) string {
	var s []string
	for _, x := range a {
		s = append(s, x.String())
	}
	return strings.Join(s, ", ")
}

// parseAllowOut parses VPN_LAN_ALLOW_OUT ("ip[:port],ip[:port]"). IPv4 only; empty = none.
func parseAllowOut(v string) ([]allowOut, error) {
	var out []allowOut
	for _, e := range strings.Split(v, ",") {
		if e = strings.TrimSpace(e); e == "" {
			continue
		}
		if ap, err := netip.ParseAddrPort(e); err == nil && ap.Addr().Is4() && ap.Port() != 0 {
			out = append(out, allowOut{ap.Addr(), ap.Port()})
		} else if a, err := netip.ParseAddr(e); err == nil && a.Is4() {
			out = append(out, allowOut{addr: a})
		} else {
			return nil, fmt.Errorf("invalid VPN_LAN_ALLOW_OUT entry %q (want IPv4[:port])", e)
		}
	}
	return out, nil
}

// parseControlTrusted parses CONTROL_TRUSTED_IPS (comma-separated IPv4 addresses; empty = the whole LAN).
func parseControlTrusted(v string) ([]netip.Addr, error) {
	var out []netip.Addr
	for _, e := range strings.Split(v, ",") {
		if e = strings.TrimSpace(e); e == "" {
			continue
		}
		a, err := netip.ParseAddr(e)
		if err != nil || !a.Is4() {
			return nil, fmt.Errorf("invalid CONTROL_TRUSTED_IPS entry %q (want IPv4 addresses)", e)
		}
		out = append(out, a)
	}
	return out, nil
}

// buildRuleset renders the nftables ruleset for a mode.
//
// LAN policy (identical in both modes, so `off` is not a way around it): nothing running as a non-root uid
// (qBittorrent, and any URL a user can make it fetch) may open a connection to LAN_CIDRS (the Docker bridge
// gateway = the host, and every sibling container). Only replies to connections the LAN opened (api/worker ->
// WebUI :8080 / control :8000) and traffic of uid 0 (this sidecar) leave towards the LAN.
//
// It is written as "accept the allowed, then drop the rest of the LAN" on purpose: a packet without a socket
// (no `meta skuid`) must fall into the drop, not into `off` mode's accept policy. The established accept is scoped
// to LAN destinations: an unscoped one would let connections opened in `off` mode survive a switch to `required`.
func buildRuleset(mode string, p fwPolicy, endpoints []netip.AddrPort) string {
	var b strings.Builder
	lan := prefixList(p.lan)
	b.WriteString("add table inet sbvpn\ndelete table inet sbvpn\ntable inet sbvpn {\n")
	b.WriteString("  chain input {\n    type filter hook input priority -10; policy accept;\n")
	fmt.Fprintf(&b, "    iifname \"wg*\" tcp dport { %s, %s } drop\n", p.controlPort, p.webPort)
	if len(p.lan) > 0 {
		b.WriteString("    iifname \"lo\" accept\n")
		b.WriteString("    ct state established,related accept\n")
		fmt.Fprintf(&b, "    ip saddr { %s } tcp dport %s accept\n", lan, p.webPort)
		if len(p.controlFrom) > 0 {
			fmt.Fprintf(&b, "    ip saddr { %s } tcp dport %s accept\n", addrList(p.controlFrom), p.controlPort)
		} else {
			fmt.Fprintf(&b, "    ip saddr { %s } tcp dport %s accept\n", lan, p.controlPort)
		}
		for _, a := range p.allowOut { // test fixtures (e.g. a seeder) may dial in
			fmt.Fprintf(&b, "    ip saddr %s accept\n", a.addr)
		}
		fmt.Fprintf(&b, "    ip saddr { %s } drop\n", lan)
	}
	b.WriteString("  }\n")
	// Defence in depth for path-MTU problems: clamp the MSS of every SYN / SYN-ACK leaving through a tunnel to the
	// route MTU. Postrouting is a separate accept-policy chain; it never lets anything out that output dropped.
	b.WriteString("  chain mss {\n    type filter hook postrouting priority mangle; policy accept;\n")
	b.WriteString("    oifname \"wg*\" tcp flags syn tcp option maxseg size set rt mtu\n  }\n")
	policy := "accept"
	if mode == "required" {
		policy = "drop"
	}
	fmt.Fprintf(&b, "  chain output {\n    type filter hook output priority -10; policy %s;\n", policy)
	if mode == "required" {
		b.WriteString("    ip daddr 127.0.0.11 meta skuid != 0 drop\n")
		b.WriteString("    meta nfproto ipv6 oifname != \"lo\" drop\n")
	}
	b.WriteString("    oifname \"lo\" accept\n")
	if mode == "required" {
		// WireGuard's own (kernel-originated, fwmarked) packets have no socket owner: accept them before the LAN drop.
		for _, e := range endpoints {
			fmt.Fprintf(&b, "    ip daddr %s udp dport %d meta mark %s accept\n", e.Addr(), e.Port(), wgFwmark)
		}
	}
	if len(p.lan) > 0 {
		fmt.Fprintf(&b, "    ip daddr { %s } ct state established,related accept\n", lan)
		for _, a := range p.allowOut {
			if a.port == 0 {
				fmt.Fprintf(&b, "    ip daddr %s accept\n", a.addr)
			} else {
				fmt.Fprintf(&b, "    ip daddr %s meta l4proto { tcp, udp } th dport %d accept\n", a.addr, a.port)
			}
		}
		fmt.Fprintf(&b, "    ip daddr { %s } meta skuid 0 accept\n", lan)
		fmt.Fprintf(&b, "    ip daddr { %s } drop\n", lan)
	}
	if mode == "required" {
		b.WriteString("    oifname \"wg*\" accept\n")
	}
	b.WriteString("  }\n}\n")
	return b.String()
}

func applyRuleset(rules string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "nft", "-f", "-")
	cmd.Stdin = strings.NewReader(rules)
	var out bytes.Buffer
	cmd.Stderr, cmd.Stdout = &out, &out
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("nft: %v: %s", err, strings.TrimSpace(out.String()))
	}
	return nil
}
