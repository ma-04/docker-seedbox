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
//	UDP endpoint(s) of the tunnel being brought up / currently up.
//	IPv6 (except loopback) is dropped. Docker's embedded resolver (127.0.0.11,
//	which forwards from the host side) is usable by root only (this process,
//	to resolve a WireGuard endpoint hostname) and never by qBittorrent.
//
// off:      OUTPUT policy accept.
// both:     INPUT from the tunnel to the control/WebUI ports is dropped, so other
//
//	customers of the VPN provider cannot reach them via the tunnel address.
func buildRuleset(mode string, lan []netip.Prefix, endpoints []netip.AddrPort, webPorts string) string {
	var b strings.Builder
	b.WriteString("add table inet sbvpn\ndelete table inet sbvpn\ntable inet sbvpn {\n")
	b.WriteString("  chain input {\n    type filter hook input priority -10; policy accept;\n")
	fmt.Fprintf(&b, "    iifname \"wg*\" tcp dport { %s } drop\n  }\n", webPorts)
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
			fmt.Fprintf(&b, "    ip daddr %s udp dport %d accept\n", e.Addr(), e.Port())
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
