//! One-time codes as a second step after the password: the six digits an
//! authenticator app shows (RFC 6238 with SHA-1, a new code every 30
//! seconds, which is what every such app reads), the QR code that hands the
//! app its secret, and the recovery codes for when the phone is gone.

use data_encoding::BASE32_NOPAD;
use hmac::{Hmac, KeyInit, Mac};
use qrcode::{Color, QrCode};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

pub const DIGITS: usize = 6;
pub const PERIOD: u64 = 30;
pub const ISSUER: &str = "proxmox-crt";
pub const RECOVERY_CODES: usize = 10;

/// Letters and digits that are not mistaken for one another.
pub const PLAIN_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RECOVERY_LENGTH: usize = 12;

/// Random text of `length` characters from the plain alphabet. It has 32
/// characters, so each byte of randomness picks one evenly.
pub fn random_plain(length: usize) -> String {
    let mut buf = vec![0u8; length];
    getrandom::fill(&mut buf).expect("the system has a random source");
    buf.iter().map(|b| PLAIN_ALPHABET[usize::from(*b) % 32] as char).collect()
}

/// A new secret, as the base32 text that apps take and the settings file
/// keeps: 160 bits, the size of the hash.
pub fn new_secret() -> String {
    let mut key = [0u8; 20];
    getrandom::fill(&mut key).expect("the system has a random source");
    BASE32_NOPAD.encode(&key)
}

/// The key behind a base32 secret, however it was typed: any case, with or
/// without spaces, dashes or padding.
pub fn decode_secret(secret: &str) -> Option<Vec<u8>> {
    let plain: String = secret
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-' && *c != '=')
        .map(|c| c.to_ascii_uppercase())
        .collect();
    BASE32_NOPAD.decode(plain.as_bytes()).ok().filter(|key| !key.is_empty())
}

/// Which 30 seconds it is now.
pub fn step_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) / PERIOD
}

/// The code for one step (RFC 4226's truncation of an HMAC of the step).
pub fn code(key: &[u8], step: u64) -> String {
    let mut mac = Hmac::<Sha1>::new_from_slice(key).expect("an HMAC takes a key of any length");
    mac.update(&step.to_be_bytes());
    let hash = mac.finalize().into_bytes();
    let at = usize::from(hash[hash.len() - 1] & 0x0f);
    let number = u32::from_be_bytes([hash[at] & 0x7f, hash[at + 1], hash[at + 2], hash[at + 3]]);
    format!("{:0width$}", number % 10u32.pow(DIGITS as u32), width = DIGITS)
}

/// The step `typed` is the code of: the one at `now`, or the one before or
/// after it, since a phone's clock and the bridge's are never quite
/// together. A step that is not after `last_used` is refused, so a code
/// read over a shoulder cannot be used a second time.
pub fn matching_step(key: &[u8], typed: &str, now: u64, last_used: Option<u64>) -> Option<u64> {
    let mut found = None;
    for step in now.saturating_sub(1)..=now + 1 {
        // Every step is compared, so that the time taken says nothing.
        if crate::auth::same(&code(key, step), typed) && found.is_none() {
            found = Some(step);
        }
    }
    found.filter(|step| last_used.is_none_or(|last| *step > last))
}

/// Whether what was typed is shaped like an app's code and not like a
/// recovery code.
pub fn looks_like_code(typed: &str) -> bool {
    typed.len() == DIGITS && typed.bytes().all(|b| b.is_ascii_digit())
}

fn percent(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            other => format!("%{other:02X}"),
        })
        .collect()
}

/// The address an authenticator app reads the secret from. `account` is
/// what the app lists the entry under.
pub fn uri(secret: &str, account: &str) -> String {
    format!(
        "otpauth://totp/{issuer}:{account}?secret={secret}&issuer={issuer}&algorithm=SHA1&digits={DIGITS}&period={PERIOD}",
        issuer = percent(ISSUER),
        account = percent(account),
    )
}

/// A QR code of `text` as an SVG picture: dark squares on white, with the
/// quiet border a camera needs around it.
pub fn qr_svg(text: &str) -> Option<String> {
    let code = QrCode::new(text.as_bytes()).ok()?;
    let width = code.width();
    let border = 4;
    let mut path = String::new();
    for (i, colour) in code.to_colors().into_iter().enumerate() {
        if colour == Color::Dark {
            path.push_str(&format!("M{},{}h1v1h-1z", i % width + border, i / width + border));
        }
    }
    let side = width + 2 * border;
    Some(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {side} {side}\" shape-rendering=\"crispEdges\" role=\"img\" \
         aria-label=\"QR code for an authenticator app\"><rect width=\"{side}\" height=\"{side}\" fill=\"#fff\"/>\
         <path d=\"{path}\" fill=\"#000\"/></svg>"
    ))
}

/// A fresh set of recovery codes, each written `XXXX-XXXX-XXXX`.
pub fn new_recovery_codes() -> Vec<String> {
    (0..RECOVERY_CODES)
        .map(|_| {
            let plain = random_plain(RECOVERY_LENGTH);
            format!("{}-{}-{}", &plain[..4], &plain[4..8], &plain[8..])
        })
        .collect()
}

/// What the settings file keeps of a recovery code: its SHA-256, as hex.
/// The code counts the same however it was typed: any case, with or without
/// its dashes or spaces.
pub fn recovery_hash(typed: &str) -> String {
    let plain: String = typed
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    Sha256::digest(plain.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The key of RFC 6238's test vectors.
    const RFC_KEY: &[u8] = b"12345678901234567890";

    /// The RFC shows eight digits; a six-digit code is the last six of them.
    #[test]
    fn the_codes_are_those_of_rfc_6238() {
        for (seconds, eight) in [
            (59u64, "94287082"),
            (1111111109, "07081804"),
            (1111111111, "14050471"),
            (1234567890, "89005924"),
            (2000000000, "69279037"),
            (20000000000, "65353130"),
        ] {
            assert_eq!(code(RFC_KEY, seconds / PERIOD), eight[2..], "at {seconds}");
        }
    }

    /// The counter values of RFC 4226's appendix D.
    #[test]
    fn the_codes_are_those_of_rfc_4226() {
        let want = [
            "755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489",
        ];
        for (count, code_wanted) in want.iter().enumerate() {
            assert_eq!(code(RFC_KEY, count as u64), *code_wanted);
        }
    }

    #[test]
    fn a_code_is_good_for_its_own_step_and_the_ones_beside_it() {
        let now = 1111111109 / PERIOD;
        for step in [now - 1, now, now + 1] {
            assert_eq!(matching_step(RFC_KEY, &code(RFC_KEY, step), now, None), Some(step));
        }
        assert_eq!(matching_step(RFC_KEY, &code(RFC_KEY, now - 2), now, None), None);
        assert_eq!(matching_step(RFC_KEY, &code(RFC_KEY, now + 2), now, None), None);
        assert_eq!(matching_step(RFC_KEY, "", now, None), None);
        assert_eq!(matching_step(RFC_KEY, "12345", now, None), None);
    }

    #[test]
    fn a_code_is_not_taken_twice() {
        let now = 1111111109 / PERIOD;
        let typed = code(RFC_KEY, now);
        assert_eq!(matching_step(RFC_KEY, &typed, now, Some(now - 1)), Some(now));
        assert_eq!(matching_step(RFC_KEY, &typed, now, Some(now)), None);
        // Nor an older one once a newer one was used.
        assert_eq!(matching_step(RFC_KEY, &code(RFC_KEY, now - 1), now, Some(now)), None);
        assert_eq!(matching_step(RFC_KEY, &code(RFC_KEY, now + 1), now, Some(now)), Some(now + 1));
    }

    #[test]
    fn a_secret_reads_back_however_it_was_typed() {
        let secret = new_secret();
        assert_eq!(secret.len(), 32);
        let key = decode_secret(&secret).unwrap();
        assert_eq!(key.len(), 20);
        let spaced = format!("{} {}==", secret[..16].to_ascii_lowercase(), &secret[16..]);
        assert_eq!(decode_secret(&spaced), Some(key));
        // The RFC's key, as an app would be given it.
        assert_eq!(decode_secret("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").as_deref(), Some(RFC_KEY));
        assert_eq!(decode_secret("not base32!"), None);
        assert_eq!(decode_secret(""), None);
        assert_ne!(new_secret(), secret);
    }

    #[test]
    fn the_address_says_what_an_app_needs() {
        assert_eq!(
            uri("GEZDGNBVGY3TQOJQ", "crt.example.com:8086"),
            "otpauth://totp/proxmox-crt:crt.example.com%3A8086?secret=GEZDGNBVGY3TQOJQ&issuer=proxmox-crt&algorithm=SHA1&digits=6&period=30"
        );
    }

    /// The picture is read back the way a phone's camera would read it.
    #[test]
    fn the_qr_code_reads_back_as_the_address() {
        let address = uri(&new_secret(), "crt.example.com");
        let svg = qr_svg(&address).unwrap();
        assert!(svg.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 "));
        assert!(svg.ends_with("</svg>"));
        assert!(!svg.contains("script"));

        let side: usize = svg
            .split("viewBox=\"0 0 ")
            .nth(1)
            .unwrap()
            .split(' ')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        let path = svg.split("<path d=\"").nth(1).unwrap().split('"').next().unwrap();
        let mut dark = vec![false; side * side];
        for square in path.split('M').skip(1) {
            let (x, rest) = square.split_once(',').unwrap();
            let (y, shape) = rest.split_once('h').unwrap();
            assert_eq!(shape, "1v1h-1z");
            dark[y.parse::<usize>().unwrap() * side + x.parse::<usize>().unwrap()] = true;
        }
        let scale = 4;
        let mut picture = rqrr::PreparedImage::prepare_from_greyscale(side * scale, side * scale, |x, y| {
            if dark[(y / scale) * side + x / scale] { 0 } else { 255 }
        });
        let grids = picture.detect_grids();
        assert_eq!(grids.len(), 1);
        assert_eq!(grids[0].decode().unwrap().1, address);
    }

    #[test]
    fn recovery_codes_are_many_and_all_different() {
        let codes = new_recovery_codes();
        assert_eq!(codes.len(), RECOVERY_CODES);
        for (i, code) in codes.iter().enumerate() {
            assert_eq!(code.len(), 14);
            assert!(!looks_like_code(code));
            assert!(code.bytes().all(|b| b == b'-' || PLAIN_ALPHABET.contains(&b)), "{code}");
            assert!(!codes[..i].contains(code));
        }
    }

    #[test]
    fn a_recovery_code_counts_however_it_was_typed() {
        let hash = recovery_hash("K7QM-2XPA-9BCD");
        assert_eq!(hash.len(), 64);
        assert_eq!(recovery_hash(" k7qm 2xpa9bcd\n"), hash);
        assert_ne!(recovery_hash("K7QM-2XPA-9BCE"), hash);
    }

    #[test]
    fn six_digits_are_an_app_code() {
        assert!(looks_like_code("012345"));
        assert!(!looks_like_code("01234"));
        assert!(!looks_like_code("0123456"));
        assert!(!looks_like_code("K7QM2X"));
    }
}
