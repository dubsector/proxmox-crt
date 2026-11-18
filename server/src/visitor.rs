//! Whose address a request is counted under. Behind a reverse proxy every
//! connection comes from the proxy, and the visitor's own address is in the
//! `X-Forwarded-For` header the proxy adds to. Anyone can write that header,
//! so it is believed only when the connection comes from a proxy the
//! settings name, and only as far as such proxies wrote it.

use axum::http::HeaderMap;
use std::net::{IpAddr, Ipv6Addr, SocketAddr};

/// The proxies the settings name under `trusted_proxies`.
#[derive(Debug, Default)]
pub(crate) struct Trusted(Vec<Range>);

/// An address or a range of them. IPv4 is kept the way IPv6 writes it
/// (`::ffff:a.b.c.d`), so that one comparison does for both, and an IPv4
/// address that arrives written as IPv6 is the same address. It also means
/// that an IPv6 range wide enough to reach `::ffff:0:0/96`, which is `::/80`
/// and anything shorter, holds every IPv4 address too, while `0.0.0.0/0`
/// holds no IPv6 one.
#[derive(Debug, PartialEq)]
struct Range {
    first: u128,
    mask: u128,
}

fn bits(address: IpAddr) -> u128 {
    match address {
        IpAddr::V4(v4) => v4.to_ipv6_mapped().to_bits(),
        IpAddr::V6(v6) => v6.to_bits(),
    }
}

impl Range {
    /// Reads `192.168.1.5`, `10.0.0.0/24` or `fd00::/8`. Bits set past the
    /// length, as in `10.0.0.7/24`, are let go: the range is the one the
    /// address lies in. An IPv4 address written as IPv6, `::ffff:10.0.0.0`,
    /// is read as the IPv4 address it is, and a length after it counts out
    /// of 32: counted out of 128, a `/24` meant for IPv4 would hold all of
    /// IPv4.
    fn parse(entry: &str) -> Option<Range> {
        let (address, length) = match entry.trim().split_once('/') {
            Some((address, length)) => (address, Some(length)),
            None => (entry.trim(), None),
        };
        let address = address.parse::<IpAddr>().ok()?.to_canonical();
        let whole = if address.is_ipv4() { 32 } else { 128 };
        let length = match length {
            // Digits alone: `parse` would take a sign as well.
            Some(length) if !length.is_empty() && length.bytes().all(|b| b.is_ascii_digit()) => length.parse().ok()?,
            Some(_) => return None,
            None => whole,
        };
        if length > whole {
            return None;
        }
        // An IPv4 length counts from where the address starts, and the
        // bits before that are part of the range as well.
        let mask = u128::MAX.checked_shl(whole - length).unwrap_or(0);
        Some(Range {
            first: bits(address) & mask,
            mask,
        })
    }

    fn holds(&self, address: IpAddr) -> bool {
        bits(address) & self.mask == self.first
    }
}

impl Trusted {
    /// Fails on an entry that is neither an address nor a range, naming it.
    /// A list that half works would count visitors under the wrong address
    /// without a word, so the bridge does not start on one.
    pub(crate) fn new(entries: &[String]) -> Result<Trusted, String> {
        let ranges = entries.iter().map(|entry| {
            Range::parse(entry).ok_or_else(|| {
                format!("trusted_proxies: \"{entry}\" is not an address or a range of them, such as 192.168.1.5 or 10.0.0.0/24")
            })
        });
        Ok(Trusted(ranges.collect::<Result<_, _>>()?))
    }

    fn holds(&self, address: IpAddr) -> bool {
        self.0.iter().any(|range| range.holds(address))
    }

    /// The address a request is counted under: `peer`, which the connection
    /// came from, unless that is one of the proxies. Then it is the last
    /// address in `X-Forwarded-For` that no such proxy stands at. Each proxy
    /// adds the address it was reached from at the right, so what is right
    /// of that address was written by proxies that are trusted, and what
    /// is left of it by nobody in particular: it is not looked at.
    ///
    /// The header can come in several lines, which read as one, in order.
    /// An entry that is no address stops the search, and the request counts
    /// under `peer`: what is left of it cannot be told from made up. That
    /// goes for an empty entry, `unknown` and bytes that are no text. A port
    /// after the address, and brackets around it, are let go. With no
    /// header, or one that names proxies only, the request counts under
    /// `peer` too.
    pub(crate) fn visitor(&self, peer: IpAddr, headers: &HeaderMap) -> IpAddr {
        if !self.holds(peer) {
            return peer;
        }
        let lines = headers.get_all("x-forwarded-for").into_iter().rev();
        for entry in lines.flat_map(|line| line.as_bytes().rsplit(|byte| *byte == b',')) {
            match forwarded(entry) {
                Some(address) if self.holds(address) => {}
                Some(address) => return address,
                None => return peer,
            }
        }
        peer
    }
}

/// One entry of `X-Forwarded-For` as an address: `1.2.3.4`, `1.2.3.4:5678`,
/// `fd00::1`, `[fd00::1]` or `[fd00::1]:5678`.
fn forwarded(entry: &[u8]) -> Option<IpAddr> {
    let entry = std::str::from_utf8(entry).ok()?.trim();
    let address = match entry.parse::<IpAddr>() {
        Ok(address) => address,
        Err(_) => match entry.parse::<SocketAddr>() {
            Ok(with_port) => with_port.ip(),
            Err(_) => IpAddr::V6(entry.strip_prefix('[')?.strip_suffix(']')?.parse::<Ipv6Addr>().ok()?),
        },
    };
    Some(address.to_canonical())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    fn trusted(entries: &[&str]) -> Trusted {
        Trusted::new(&entries.iter().map(|entry| entry.to_string()).collect::<Vec<_>>()).unwrap()
    }

    /// A request with these `X-Forwarded-For` lines.
    fn lines(lines: &[&str]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for line in lines {
            headers.append("x-forwarded-for", HeaderValue::from_str(line).unwrap());
        }
        headers
    }

    #[test]
    fn an_entry_is_an_address_or_a_range_of_them() {
        for (entry, inside, outside) in [
            (
                "192.168.1.5",
                vec!["192.168.1.5", "::ffff:192.168.1.5"],
                vec!["192.168.1.4", "192.168.1.6", "::1"],
            ),
            ("192.168.1.5/32", vec!["192.168.1.5"], vec!["192.168.1.4"]),
            (
                "10.0.0.0/24",
                vec!["10.0.0.0", "10.0.0.255", "::ffff:10.0.0.9"],
                vec!["10.0.1.0", "9.255.255.255", "fd00::1"],
            ),
            ("10.0.0.7/24", vec!["10.0.0.200"], vec!["10.0.1.7"]),
            (
                "172.16.0.0/12",
                vec!["172.16.0.1", "172.31.255.255"],
                vec!["172.32.0.0", "172.15.255.255"],
            ),
            ("0.0.0.0/0", vec!["1.2.3.4", "255.255.255.255"], vec!["::1", "fd00::1"]),
            ("fd00::/8", vec!["fd00::1", "fdff:ffff::1"], vec!["fe00::1", "fc00::1", "10.0.0.1"]),
            ("fd00::5", vec!["fd00::5"], vec!["fd00::6"]),
            ("2001:db8::/127", vec!["2001:db8::", "2001:db8::1"], vec!["2001:db8::2"]),
            // IPv4 is held as `::ffff:a.b.c.d`, which these reach or do not.
            ("::/0", vec!["::1", "2001:db8::1", "1.2.3.4", "::ffff:1.2.3.4"], vec![]),
            ("::/80", vec!["::1", "1.2.3.4"], vec!["2001:db8::1"]),
            ("::/81", vec!["::1"], vec!["1.2.3.4", "2001:db8::1"]),
            (" 192.168.1.5 ", vec!["192.168.1.5"], vec![]),
            ("::ffff:192.168.1.5", vec!["192.168.1.5"], vec!["192.168.1.6"]),
            // The length after an IPv4 address written as IPv6 is an IPv4 one.
            (
                "::ffff:10.0.0.0/24",
                vec!["10.0.0.9", "::ffff:10.0.0.9"],
                vec!["10.0.1.0", "1.2.3.4", "192.168.1.5", "::1"],
            ),
            ("::ffff:10.0.0.7/32", vec!["10.0.0.7"], vec!["10.0.0.8"]),
        ] {
            let range = Range::parse(entry).unwrap_or_else(|| panic!("{entry} is read"));
            for address in inside {
                assert!(range.holds(ip(address)), "{address} is in {entry}");
            }
            for address in outside {
                assert!(!range.holds(ip(address)), "{address} is not in {entry}");
            }
        }
    }

    #[test]
    fn an_entry_that_is_neither_is_named_and_stops_the_start() {
        for entry in [
            "",
            "myproxy",
            "192.168.1",
            "192.168.1.5/33",
            "192.168.1.5/",
            "192.168.1.5/+8",
            "192.168.1.5/-1",
            "192.168.1.5/24/24",
            "192.168.1.5:8080",
            "fd00::/129",
            "::ffff:10.0.0.0/120",
            "::ffff:0:0/96",
            "[fd00::1]",
            "10.0.0.0/255.255.255.0",
            "/24",
        ] {
            assert_eq!(Range::parse(entry), None, "{entry}");
            let refused = Trusted::new(&["192.168.1.5".into(), entry.into()]).unwrap_err();
            assert!(refused.contains(&format!("trusted_proxies: \"{entry}\"")), "{refused}");
        }
    }

    #[test]
    fn with_no_proxy_named_the_header_is_not_looked_at() {
        let nobody = trusted(&[]);
        for peer in ["192.168.1.5", "127.0.0.1", "::1", "::ffff:192.168.1.5"] {
            assert_eq!(nobody.visitor(ip(peer), &lines(&["203.0.113.7"])), ip(peer));
            assert_eq!(nobody.visitor(ip(peer), &HeaderMap::new()), ip(peer));
        }
    }

    #[test]
    fn a_header_from_anyone_but_the_proxy_is_not_looked_at() {
        let proxy = trusted(&["192.168.1.5"]);
        assert_eq!(proxy.visitor(ip("192.168.1.66"), &lines(&["203.0.113.7"])), ip("192.168.1.66"));
        assert_eq!(proxy.visitor(ip("192.168.1.66"), &lines(&["192.168.1.5"])), ip("192.168.1.66"));
        assert_eq!(proxy.visitor(ip("fd00::66"), &lines(&["203.0.113.7"])), ip("fd00::66"));
    }

    #[test]
    fn behind_the_proxy_a_visitor_is_the_address_the_proxy_wrote() {
        let proxy = trusted(&["192.168.1.5"]);
        let peer = ip("192.168.1.5");
        assert_eq!(proxy.visitor(peer, &lines(&["203.0.113.7"])), ip("203.0.113.7"));
        assert_eq!(proxy.visitor(peer, &lines(&["2001:db8::7"])), ip("2001:db8::7"));
        assert_eq!(proxy.visitor(peer, &lines(&["  203.0.113.7  "])), ip("203.0.113.7"));
        // An IPv4 address written as IPv6 is the address it is.
        assert_eq!(proxy.visitor(peer, &lines(&["::ffff:203.0.113.7"])), ip("203.0.113.7"));
        // The proxy says nothing: there is only its own address to go by.
        assert_eq!(proxy.visitor(peer, &HeaderMap::new()), peer);
        assert_eq!(proxy.visitor(peer, &lines(&["192.168.1.5"])), peer);
    }

    #[test]
    fn what_a_visitor_wrote_into_the_header_is_not_believed() {
        let proxy = trusted(&["192.168.1.5"]);
        let peer = ip("192.168.1.5");
        // The proxy adds at the right what it saw. Left of that is what
        // the visitor sent along, which may be anything.
        for made_up in [
            "198.51.100.1, 203.0.113.7",
            "192.168.1.5, 203.0.113.7",
            "127.0.0.1, 198.51.100.1, 203.0.113.7",
            "unknown, 203.0.113.7",
            ", 203.0.113.7",
        ] {
            assert_eq!(proxy.visitor(peer, &lines(&[made_up])), ip("203.0.113.7"), "{made_up}");
        }
    }

    #[test]
    fn a_chain_of_proxies_is_followed_back_to_the_first_stranger() {
        let proxies = trusted(&["192.168.1.5", "10.0.0.0/24"]);
        let peer = ip("192.168.1.5");
        assert_eq!(proxies.visitor(peer, &lines(&["203.0.113.7, 10.0.0.2"])), ip("203.0.113.7"));
        assert_eq!(
            proxies.visitor(peer, &lines(&["198.51.100.1, 203.0.113.7, 10.0.0.2, 10.0.0.3"])),
            ip("203.0.113.7")
        );
        // With the outer proxy not named, it is the visitor.
        let inner = trusted(&["192.168.1.5"]);
        assert_eq!(inner.visitor(peer, &lines(&["203.0.113.7, 10.0.0.2"])), ip("10.0.0.2"));
        // Proxies all the way: the one that connected.
        assert_eq!(proxies.visitor(peer, &lines(&["10.0.0.2, 10.0.0.3"])), peer);
    }

    #[test]
    fn a_proxy_that_connects_as_ipv4_written_as_ipv6_is_still_the_proxy() {
        let proxy = trusted(&["192.168.1.5", "fd00::/8"]);
        assert_eq!(proxy.visitor(ip("::ffff:192.168.1.5"), &lines(&["203.0.113.7"])), ip("203.0.113.7"));
        assert_eq!(
            proxy.visitor(ip("::ffff:192.168.1.6"), &lines(&["203.0.113.7"])),
            ip("::ffff:192.168.1.6")
        );
        assert_eq!(proxy.visitor(ip("fd00::5"), &lines(&["203.0.113.7"])), ip("203.0.113.7"));
        assert_eq!(
            proxy.visitor(ip("192.168.1.5"), &lines(&["203.0.113.7, ::ffff:192.168.1.5"])),
            ip("203.0.113.7")
        );
    }

    #[test]
    fn an_entry_that_is_no_address_leaves_the_proxys_own() {
        let proxy = trusted(&["192.168.1.5", "10.0.0.2"]);
        let peer = ip("192.168.1.5");
        for garbage in [
            "",
            " ",
            ",",
            ",,,",
            "unknown",
            "203.0.113.7, unknown",
            "203.0.113.7,",
            "203.0.113.7, , 10.0.0.2",
            "203.0.113.7 10.0.0.2",
            "203.0.113.7; 10.0.0.2",
            "203.0.113",
            "203.0.113.7.1",
            "0x7f.1",
            "fe80::1%eth0",
            "[203.0.113.7]",
            "[fd00::1",
            "fd00::1]:80",
            "203.0.113.7:",
            "203.0.113.7:99999",
            "example.com",
            "_hidden",
        ] {
            assert_eq!(proxy.visitor(peer, &lines(&[garbage])), peer, "{garbage:?}");
        }
        // Bytes that are no text, and a great many entries.
        let mut headers = HeaderMap::new();
        headers.append("x-forwarded-for", HeaderValue::from_bytes(b"203.0.113.7, \xff\xfe\x80").unwrap());
        assert_eq!(proxy.visitor(peer, &headers), peer);
        let mut headers = HeaderMap::new();
        headers.append("x-forwarded-for", HeaderValue::from_bytes(b"\xff203.0.113.7, 203.0.113.8").unwrap());
        assert_eq!(proxy.visitor(peer, &headers), ip("203.0.113.8"));
        let long = format!("203.0.113.7{}", ", 10.0.0.2".repeat(100_000));
        assert_eq!(proxy.visitor(peer, &lines(&[&long])), ip("203.0.113.7"));
        let long = ",".repeat(1_000_000);
        assert_eq!(proxy.visitor(peer, &lines(&[&long])), peer);
    }

    #[test]
    fn a_port_or_brackets_around_the_address_are_let_go() {
        let proxy = trusted(&["192.168.1.5", "fd00::/8"]);
        let peer = ip("192.168.1.5");
        for (entry, visitor) in [
            ("203.0.113.7:5678", "203.0.113.7"),
            ("[2001:db8::7]:1234", "2001:db8::7"),
            ("[2001:db8::7]", "2001:db8::7"),
            ("[::ffff:203.0.113.7]:1234", "203.0.113.7"),
            // A proxy that writes itself with a port is the proxy still.
            ("203.0.113.7, [fd00::2]:443, 192.168.1.5:80", "203.0.113.7"),
        ] {
            assert_eq!(proxy.visitor(peer, &lines(&[entry])), ip(visitor), "{entry}");
        }
    }

    #[test]
    fn several_header_lines_read_as_one() {
        let proxies = trusted(&["192.168.1.5", "10.0.0.0/24"]);
        let peer = ip("192.168.1.5");
        assert_eq!(proxies.visitor(peer, &lines(&["198.51.100.1", "203.0.113.7"])), ip("203.0.113.7"));
        assert_eq!(
            proxies.visitor(peer, &lines(&["198.51.100.1, 203.0.113.7", "10.0.0.2", "10.0.0.3, 10.0.0.4"])),
            ip("203.0.113.7")
        );
        assert_eq!(proxies.visitor(peer, &lines(&["203.0.113.7", "10.0.0.2", ""])), peer);
        assert_eq!(proxies.visitor(peer, &lines(&["203.0.113.7", "unknown", "10.0.0.2"])), peer);
        // The header's name is the same however it is written.
        let mut headers = HeaderMap::new();
        headers.append(
            "X-Forwarded-For".parse::<axum::http::HeaderName>().unwrap(),
            HeaderValue::from_static("203.0.113.7"),
        );
        assert_eq!(proxies.visitor(peer, &headers), ip("203.0.113.7"));
    }

    #[test]
    fn other_headers_that_name_an_address_are_not_read() {
        let proxy = trusted(&["192.168.1.5"]);
        let peer = ip("192.168.1.5");
        let mut headers = HeaderMap::new();
        headers.append("forwarded", HeaderValue::from_static("for=203.0.113.7"));
        headers.append("x-real-ip", HeaderValue::from_static("203.0.113.7"));
        assert_eq!(proxy.visitor(peer, &headers), peer);
    }
}
