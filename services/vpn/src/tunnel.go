package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// run executes a binary directly (never through a shell). Every argument is built
// from validated values.
func run(stdin string, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	s := strings.TrimSpace(out.String())
	if err != nil {
		if len(s) > 200 {
			s = s[:200]
		}
		return s, fmt.Errorf("%s %s: %v: %s", name, args[0], err, s)
	}
	return s, nil
}

// defaultRoute returns the gateway and device of the container's normal default route.
func defaultRoute() (gw netip.Addr, dev string, err error) {
	out, err := run("", "ip", "-4", "route", "show", "default")
	if err != nil {
		return gw, "", err
	}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		var via, d string
		for i := 0; i+1 < len(f); i++ {
			switch f[i] {
			case "via":
				via = f[i+1]
			case "dev":
				d = f[i+1]
			}
		}
		if d != "" && !strings.HasPrefix(d, "wg") {
			a, _ := netip.ParseAddr(via)
			return a, d, nil
		}
	}
	return gw, "", errors.New("no default route")
}

func routeArgs(prefix string, gw netip.Addr, dev string) []string {
	a := []string{"-4", "route", "replace", prefix}
	if gw.IsValid() {
		a = append(a, "via", gw.String())
	}
	return append(a, "dev", dev)
}

// resolveEndpoint returns an IPv4 endpoint. Hostnames are resolved through the
// container's original (Docker) resolver, which the kill switch lets root use.
func (s *Server) resolveEndpoint(host string, port int) (netip.AddrPort, error) {
	if a, err := netip.ParseAddr(host); err == nil {
		if !a.Is4() {
			return netip.AddrPort{}, errors.New("IPv6 endpoints are not supported")
		}
		return netip.AddrPortFrom(a, uint16(port)), nil
	}
	if s.origNS == "" {
		return netip.AddrPort{}, errors.New("no resolver available to resolve the endpoint host")
	}
	r := &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 4 * time.Second}).DialContext(ctx, network, net.JoinHostPort(s.origNS, "53"))
	}}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	addrs, err := r.LookupNetIP(ctx, "ip4", host)
	if err != nil || len(addrs) == 0 {
		return netip.AddrPort{}, errors.New("cannot resolve endpoint host")
	}
	return netip.AddrPortFrom(addrs[0].Unmap(), uint16(port)), nil
}

func handshakeAge(iface string) (int64, bool) {
	out, err := run("", "wg", "show", iface, "latest-handshakes")
	if err != nil {
		return 0, false
	}
	f := strings.Fields(out)
	if len(f) < 2 {
		return 0, false
	}
	ts, err := strconv.ParseInt(f[len(f)-1], 10, 64)
	if err != nil || ts == 0 {
		return 0, false
	}
	age := time.Now().Unix() - ts
	if age < 0 {
		age = 0
	}
	return age, true
}

func wgSetConf(iface string, c *WGConfig, ep netip.AddrPort) error {
	var b strings.Builder
	b.WriteString("[Interface]\nPrivateKey = " + c.PrivateKey + "\nFwMark = " + wgFwmark + "\n[Peer]\nPublicKey = " + c.PublicKey + "\n")
	if c.PresharedKey != "" {
		b.WriteString("PresharedKey = " + c.PresharedKey + "\n")
	}
	var al []string
	for _, p := range c.AllowedIPs {
		al = append(al, p.String())
	}
	fmt.Fprintf(&b, "AllowedIPs = %s\nEndpoint = %s\nPersistentKeepalive = %d\n", strings.Join(al, ", "), ep, c.Keepalive)
	// The key travels over stdin only; it is never written to disk or put in argv.
	_, err := run(b.String(), "wg", "setconf", iface, "/dev/stdin")
	return err
}

func writeResolv(content string) {
	// In place (same inode): the file is shared with the qbittorrent container.
	if err := os.WriteFile("/etc/resolv.conf", []byte(content), 0o644); err != nil {
		logf("warn: cannot write resolv.conf: %v", err)
	}
}
