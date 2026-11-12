package main

import (
	"bytes"
	"context"
	"fmt"
	"net/netip"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// The firewall is a single nftables table owned by this process. It is replaced
// atomically (one `nft -f` transaction), so there is never a moment with no rules
// while switching tunnels. Docker's own iptables rules (embedded DNS DNAT) are not
// touched.
//
// required: OUTPUT policy drop; allowed = loopback (the lo device only), wg interfaces, the UDP endpoint(s) of the tunnel
//
//	being brought up / currently up (only for packets carrying wgFwmark, WireGuard's own), replies to connections the
//	LAN opened (ct established/related) and nothing else towards LAN_CIDRS. IPv6 (except loopback) is dropped.
//	Docker's embedded resolver (127.0.0.11, reached over lo) is usable by root only (this process, to resolve a
//	WireGuard endpoint hostname) and never by qBittorrent.
//
// off:      OUTPUT policy accept (internet-direct), but the same private-range rules as in required.
// both:     every uid (root included: there is no uid exemption) is dropped towards LAN_CIDRS and towards every private /
//
//	loopback-adjacent / link-local / CGNAT / multicast / reserved IPv4 range (blockedV4: other Docker bridges and the
//	host at 172.17.0.1, RFC1918, 169.254.169.254 cloud metadata, ...), on every interface except the lo device and,
//	via wg*, the tunnel's own DNS servers (port 53). Exceptions are only the fwmarked endpoint packets, replies to
//	LAN-initiated connections and the test-only VPN_LAN_ALLOW_OUT list. All IPv6 leaving lo is dropped.
//	INPUT from the tunnel to the control/WebUI ports is dropped, so other customers of the VPN provider cannot
//	reach them via the tunnel address; INPUT from the LAN is limited to the WebUI and control ports.
//	New connections to the search port (Jackett) are accepted from SEARCH_TRUSTED_IPS only (the api container) and
//	to the loopback-only ports (FlareSolverr) from nothing but lo, on EVERY interface (LAN, tunnel, any other).
//
// wgFwmark is set on every WireGuard interface (`FwMark` in the wg conf). The kernel stamps it on the OUTER
// (encrypted) UDP packets of the tunnel, and only those: they are kernel-originated, carry no socket owner (so
// `meta skuid` cannot tell them apart from nothing) and qBittorrent (uid 1000, no CAP_NET_ADMIN) cannot set
// SO_MARK. The endpoint exception below matches this mark, so a torrent peer/tracker/DHT node that happens to
// share the endpoint's IP:port gets no direct, cleartext path from the real address.
const wgFwmark = "0x5b76"

// blockedV4 is every IPv4 range an untrusted process (qBittorrent, or any URL it is made to fetch) must not reach.
// The lo device is accepted before this list, so 127/8 here only matters for packets leaving through a real interface.
// RFC 5737 documentation ranges are deliberately NOT listed: the hermetic test stacks use them as their fake internet.
var blockedV4 = []string{
	"0.0.0.0/8",      // "this network"
	"10.0.0.0/8",     // RFC 1918
	"100.64.0.0/10",  // CGNAT (RFC 6598)
	"127.0.0.0/8",    // loopback
	"169.254.0.0/16", // link-local, cloud metadata (169.254.169.254)
	"172.16.0.0/12",  // RFC 1918: also every other Docker bridge and the Docker host (172.17.0.1)
	"192.0.0.0/24",   // IETF protocol assignments
	"192.168.0.0/16", // RFC 1918
	"198.18.0.0/15",  // benchmarking
	"224.0.0.0/4",    // multicast
	"240.0.0.0/4",    // reserved + limited broadcast
}

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
	allowOut    []allowOut   // test-only LAN exceptions
	searchPort  string       // torrent search backend (Jackett) port
	searchFrom  []netip.Addr // sources allowed to open connections to searchPort; empty = nobody
	localOnly   []string     // ports reachable over lo only (FlareSolverr: Jackett talks to it on 127.0.0.1)
	searchUID   string       // uid Jackett runs as: the only non-root uid allowed to the search / local-only ports over lo
}

// loopbackRules: who may open connections over lo. Every process in the namespace shares one loopback (the sidecar,
// qBittorrent, Jackett, FlareSolverr), so the port alone says nothing; the socket owner does. qBittorrent and FlareSolverr
// run as uid 1000, Jackett as searchUID (compose: 1001), the sidecar as root.
//   - control port: root only (the sidecar's own healthcheck). Nothing else in the namespace has the token anyway.
//   - search + local-only ports (Jackett, FlareSolverr): root (the sidecar's /companions probe) and Jackett only, so
//     neither qBittorrent nor FlareSolverr's browser can reach Jackett's unauthenticated admin API, and only Jackett can
//     drive FlareSolverr.
//   - WebUI port: never Jackett (qBittorrent itself requires a login for loopback clients as well: LocalHostAuth=true).
//
// A packet without a socket (no skuid) does not match `meta skuid` and is left to the rules below.
func (p fwPolicy) loopbackRules() []string {
	var r []string
	r = append(r, fmt.Sprintf(`oifname "lo" tcp dport %s meta skuid != 0 drop`, p.controlPort))
	if closed := p.closedPorts(); len(closed) > 0 {
		allowed := "0"
		if p.searchUID != "" {
			allowed = "0, " + p.searchUID
		}
		r = append(r, fmt.Sprintf(`oifname "lo" tcp dport { %s } meta skuid != { %s } drop`, strings.Join(closed, ", "), allowed))
	}
	if p.searchUID != "" {
		r = append(r, fmt.Sprintf(`oifname "lo" tcp dport %s meta skuid %s drop`, p.webPort, p.searchUID))
	}
	return r
}

// closedPorts is every port that must never accept a new connection from outside the namespace, except searchPort
// from searchFrom.
func (p fwPolicy) closedPorts() []string {
	var out []string
	if p.searchPort != "" {
		out = append(out, p.searchPort)
	}
	return append(out, p.localOnly...)
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

// parsePorts parses a comma-separated list of TCP ports (LOCAL_ONLY_PORTS); empty = none.
func parsePorts(name, v string) ([]string, error) {
	var out []string
	for _, e := range strings.Split(v, ",") {
		if e = strings.TrimSpace(e); e == "" {
			continue
		}
		n, err := strconv.Atoi(e)
		if err != nil || n < 1 || n > 65535 {
			return nil, fmt.Errorf("invalid %s entry %q (want TCP ports)", name, e)
		}
		out = append(out, strconv.Itoa(n))
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

// buildRuleset renders the nftables ruleset for a mode. `dns` are the tunnel's DNS servers (reached through wg*).
//
// Policy (identical in both modes, so `off` is not a way around it): nothing may open a connection to LAN_CIDRS (the
// Docker bridge gateway = the host, and every sibling container) or to any other private/reserved IPv4 range, whatever
// uid it runs as. The only exceptions are, in this order: loopback, fwmarked WireGuard endpoint packets (required),
// replies to connections the LAN opened (api/worker -> WebUI :8080 / control :8000), the test-only allow-list, and the
// tunnel's own DNS servers on port 53 through a wg interface. Docker's embedded resolver (127.0.0.11) is on the lo
// device, so the sidecar's own endpoint-hostname lookups need no LAN access at all.
//
// It is written as "accept the allowed, then drop the rest" on purpose: a packet without a socket (no `meta skuid`)
// must fall into the drop, not into `off` mode's accept policy. The established accept is scoped to LAN destinations:
// an unscoped one would let connections opened in `off` mode survive a switch to `required`.
//
// Private destinations through the tunnel are dropped too (except the DNS servers): the provider's internal network
// is not something a torrent client should probe, and a DNS server is all the sidecar and qBittorrent need there.
func buildRuleset(mode string, p fwPolicy, endpoints []netip.AddrPort, dns []netip.Addr) string {
	var b strings.Builder
	lan := prefixList(p.lan)
	b.WriteString("add table inet sbvpn\ndelete table inet sbvpn\ntable inet sbvpn {\n")
	b.WriteString("  chain input {\n    type filter hook input priority -10; policy accept;\n")
	fmt.Fprintf(&b, "    iifname \"wg*\" tcp dport { %s, %s } drop\n", p.controlPort, p.webPort)
	b.WriteString("    iifname \"lo\" accept\n")
	b.WriteString("    ct state established,related accept\n")
	// The search backend and its helpers: before every LAN accept (allow-listed fixtures included) and on every
	// interface, so neither a sibling container nor the tunnel side can open a connection to them.
	if p.searchPort != "" && len(p.searchFrom) > 0 {
		fmt.Fprintf(&b, "    iifname != \"wg*\" ip saddr { %s } tcp dport %s accept\n", addrList(p.searchFrom), p.searchPort)
	}
	if closed := p.closedPorts(); len(closed) > 0 {
		fmt.Fprintf(&b, "    tcp dport { %s } drop\n", strings.Join(closed, ", "))
	}
	if len(p.lan) > 0 {
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
	}
	b.WriteString("    meta nfproto ipv6 oifname != \"lo\" drop\n") // IPv6 is disabled in the namespace; nothing may use it
	for _, l := range p.loopbackRules() {
		fmt.Fprintf(&b, "    %s\n", l)
	}
	b.WriteString("    oifname \"lo\" accept\n")
	if mode == "required" {
		// WireGuard's own (kernel-originated, fwmarked) packets have no socket owner: accept them before the drops.
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
		fmt.Fprintf(&b, "    ip daddr { %s } drop\n", lan)
	}
	if mode == "required" && len(dns) > 0 {
		fmt.Fprintf(&b, "    oifname \"wg*\" ip daddr { %s } meta l4proto { tcp, udp } th dport 53 accept\n", addrList(dns))
	}
	fmt.Fprintf(&b, "    ip daddr { %s } drop\n", strings.Join(blockedV4, ", "))
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
