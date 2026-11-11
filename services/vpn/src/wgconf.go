package main

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
)

// WGConfig is the sanitised subset of a wg-quick file that we act on. Nothing in a
// config is ever executed: only these whitelisted keys are read, everything else is
// ignored, and files containing hook keys are rejected outright.
type WGConfig struct {
	PrivateKey   string
	Addresses    []netip.Prefix // IPv4 only
	DNS          []netip.Addr   // IPv4 only
	MTU          int            // 0 = not set in the file (see resolveMTU)
	PublicKey    string
	PresharedKey string
	AllowedIPs   []netip.Prefix // IPv4 only
	EndpointHost string
	EndpointPort int
	Keepalive    int
}

var forbiddenKey = regexp.MustCompile(`(?i)^(preup|postup|predown|postdown|saveconfig)$`)
var nameRe = regexp.MustCompile(`^[A-Za-z0-9_.@:+ -]{1,64}$`)
var hostRe = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$`)

// keyRe is the exact form of a WireGuard key: 32 bytes as 44 base64 characters. base64.StdEncoding.DecodeString alone
// also skips \r and \n inside the string, so a decoder check is not enough.
var keyRe = regexp.MustCompile(`^[A-Za-z0-9+/]{43}=$`)

func validKey(k string) bool {
	if !keyRe.MatchString(k) {
		return false
	}
	b, err := base64.StdEncoding.DecodeString(k)
	return err == nil && len(b) == 32
}

func splitList(v string) []string {
	var out []string
	for _, p := range strings.Split(v, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// ParseWGConfig parses wg-quick text. IPv6 addresses, DNS servers and AllowedIPs are
// dropped (IPv6 is never used); a config with no IPv4 left is rejected.
func ParseWGConfig(text string) (*WGConfig, error) {
	if len(text) > 16*1024 {
		return nil, errors.New("config too large")
	}
	c := &WGConfig{Keepalive: 25}
	section := ""
	peers := 0
	var sawAllowed bool
	for i, raw := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		line := raw
		if j := strings.IndexByte(line, '#'); j >= 0 {
			line = line[:j]
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "[") {
			switch strings.ToLower(line) {
			case "[interface]":
				if section != "" {
					return nil, errors.New("only one [Interface] section is allowed")
				}
				section = "interface"
			case "[peer]":
				peers++
				if peers > 1 {
					return nil, errors.New("exactly one [Peer] section is supported")
				}
				section = "peer"
			default:
				return nil, fmt.Errorf("line %d: unknown section", i+1)
			}
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			return nil, fmt.Errorf("line %d: expected key = value", i+1)
		}
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		if forbiddenKey.MatchString(k) {
			return nil, errors.New("PreUp/PostUp/PreDown/PostDown/SaveConfig are not allowed")
		}
		switch section + "." + strings.ToLower(k) {
		case "interface.privatekey":
			if !validKey(v) {
				return nil, errors.New("invalid PrivateKey")
			}
			c.PrivateKey = v
		case "interface.address":
			for _, s := range splitList(v) {
				p, err := netip.ParsePrefix(s)
				if err != nil {
					if a, e2 := netip.ParseAddr(s); e2 == nil {
						p, err = netip.PrefixFrom(a, a.BitLen()), nil
					}
				}
				if err != nil {
					return nil, errors.New("invalid Address")
				}
				if p.Addr().Is4() {
					c.Addresses = append(c.Addresses, p)
				}
			}
		case "interface.dns":
			for _, s := range splitList(v) {
				if a, err := netip.ParseAddr(s); err == nil && a.Is4() {
					c.DNS = append(c.DNS, a)
				} // search domains and IPv6 resolvers are ignored
			}
		case "interface.mtu":
			n, err := strconv.Atoi(v)
			if err != nil || !validMTU(n) {
				return nil, fmt.Errorf("invalid MTU (must be %d-%d)", minMTU, maxMTU)
			}
			c.MTU = n
		case "peer.publickey":
			if !validKey(v) {
				return nil, errors.New("invalid PublicKey")
			}
			c.PublicKey = v
		case "peer.presharedkey":
			if !validKey(v) {
				return nil, errors.New("invalid PresharedKey")
			}
			c.PresharedKey = v
		case "peer.allowedips":
			sawAllowed = true
			for _, s := range splitList(v) {
				p, err := netip.ParsePrefix(s)
				if err != nil {
					return nil, errors.New("invalid AllowedIPs")
				}
				if p.Addr().Is4() {
					c.AllowedIPs = append(c.AllowedIPs, p.Masked())
				} // ::/0 and other IPv6 prefixes are stripped
			}
		case "peer.endpoint":
			h, p, err := net.SplitHostPort(v)
			if err != nil {
				return nil, errors.New("invalid Endpoint")
			}
			port, err := strconv.Atoi(p)
			if err != nil || port < 1 || port > 65535 {
				return nil, errors.New("invalid Endpoint port")
			}
			if _, e := netip.ParseAddr(h); e != nil && !hostRe.MatchString(h) {
				return nil, errors.New("invalid Endpoint host")
			}
			c.EndpointHost, c.EndpointPort = h, port
		case "peer.persistentkeepalive":
			n, err := strconv.Atoi(v)
			if err != nil || n < 0 || n > 65535 {
				return nil, errors.New("invalid PersistentKeepalive")
			}
			if n > 0 {
				c.Keepalive = n // 0/off is not honoured: a handshake needs the keepalive
			}
		}
	}
	switch {
	case section == "" || peers != 1:
		return nil, errors.New("config needs an [Interface] and one [Peer] section")
	case c.PrivateKey == "":
		return nil, errors.New("missing Interface PrivateKey")
	case len(c.Addresses) == 0:
		return nil, errors.New("missing IPv4 Interface Address")
	case c.PublicKey == "":
		return nil, errors.New("missing Peer PublicKey")
	case c.EndpointHost == "":
		return nil, errors.New("missing Peer Endpoint")
	case !sawAllowed || len(c.AllowedIPs) == 0:
		return nil, errors.New("Peer AllowedIPs has no IPv4 entry")
	}
	return c, nil
}

func validName(n string) bool { return nameRe.MatchString(n) }

const (
	minMTU = 576
	maxMTU = 1500
	// defaultMTU is deliberately conservative. The Docker bridge always reports 1500, hiding a smaller real uplink MTU
	// (cloud VMs commonly 1460, PPPoE 1492, overlay networks lower). WireGuard adds 60 bytes (IPv4 outer) so the
	// usual 1420 only works if the real path is >= 1480; otherwise full-size packets are black-holed and bulk TCP
	// stalls while small requests still work. 1280 is the IPv6 minimum MTU and what several VPN clients default
	// to; the throughput cost versus 1420 is ~10%.
	defaultMTU = 1280
)

func validMTU(n int) bool { return n >= minMTU && n <= maxMTU }

// parseMTUEnv parses VPN_MTU ("" = unset -> 0).
func parseMTUEnv(v string) (int, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || !validMTU(n) {
		return 0, fmt.Errorf("VPN_MTU must be an integer %d-%d", minMTU, maxMTU)
	}
	return n, nil
}

// resolveMTU: explicit MTU in the uploaded config > VPN_MTU (envMTU, 0 = unset) > defaultMTU.
func resolveMTU(cfgMTU, envMTU int) int {
	switch {
	case cfgMTU != 0:
		return cfgMTU
	case envMTU != 0:
		return envMTU
	}
	return defaultMTU
}
