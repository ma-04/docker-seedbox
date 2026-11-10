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
// required: OUTPUT policy drop; allowed = loopback, LAN_CIDRS, wg interfaces, and the
//
//	UDP endpoint(s) of the tunnel being brought up / currently up, and only
//	for packets carrying wgFwmark (WireGuard's own).
//	IPv6 (except loopback) is dropped. Docker's embedded resolver (127.0.0.11,
//	which forwards from the host side) is usable by root only (this process,
//	to resolve a WireGuard endpoint hostname) and never by qBittorrent.
//
// off:      OUTPUT policy accept.
// both:     INPUT from the tunnel to the control/WebUI ports is dropped, so other
//
//	customers of the VPN provider cannot reach them via the tunnel address.
//
// wgFwmark is set on every WireGuard interface (`FwMark` in the wg conf). The kernel stamps it on the OUTER
// (encrypted) UDP packets of the tunnel, and only those: they are kernel-originated, carry no socket owner (so
// `meta skuid` cannot tell them apart from nothing) and qBittorrent (uid 1000, no CAP_NET_ADMIN) cannot set
// SO_MARK. The endpoint exception below matches this mark, so a torrent peer/tracker/DHT node that happens to
// share the endpoint's IP:port gets no direct, cleartext path from the real address.
const wgFwmark = "0x5b76"

func buildRuleset(mode string, lan []netip.Prefix, endpoints []netip.AddrPort, webPorts string) string {
	var b strings.Builder
	b.WriteString("add table inet sbvpn\ndelete table inet sbvpn\ntable inet sbvpn {\n")
	b.WriteString("  chain input {\n    type filter hook input priority -10; policy accept;\n")
	fmt.Fprintf(&b, "    iifname \"wg*\" tcp dport { %s } drop\n  }\n", webPorts)
	// Defence in depth for path-MTU problems: clamp the MSS of every SYN / SYN-ACK leaving through a tunnel to the
	// route MTU. Postrouting is a separate accept-policy chain; it never lets anything out that output dropped.
	b.WriteString("  chain mss {\n    type filter hook postrouting priority mangle; policy accept;\n")
	b.WriteString("    oifname \"wg*\" tcp flags syn tcp option maxseg size set rt mtu\n  }\n")
	if mode == "required" {
		b.WriteString("  chain output {\n    type filter hook output priority -10; policy drop;\n")
		b.WriteString("    ip daddr 127.0.0.11 meta skuid != 0 drop\n")
		b.WriteString("    meta nfproto ipv6 oifname != \"lo\" drop\n")
		b.WriteString("    oifname \"lo\" accept\n")
		if len(lan) > 0 {
			var s []string
			for _, p := range lan {
				s = append(s, p.String())
			}
			fmt.Fprintf(&b, "    ip daddr { %s } accept\n", strings.Join(s, ", "))
		}
		b.WriteString("    oifname \"wg*\" accept\n")
		for _, e := range endpoints {
			fmt.Fprintf(&b, "    ip daddr %s udp dport %d meta mark %s accept\n", e.Addr(), e.Port(), wgFwmark)
		}
		b.WriteString("  }\n")
	} else {
		b.WriteString("  chain output {\n    type filter hook output priority -10; policy accept;\n  }\n")
	}
	b.WriteString("}\n")
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
