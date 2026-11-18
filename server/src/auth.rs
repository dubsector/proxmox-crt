//! Who may use the page. The bridge can open consoles, so the page asks for
//! a password and the bridge remembers who gave it by a cookie.

use argon2::Argon2;
use argon2::password_hash::phc::PasswordHash;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv6Addr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const COOKIE: &str = "crt_session";
pub const SESSION_DAYS: u64 = 30;
pub const MIN_PASSWORD: usize = 8;

const SESSION_LIFE: Duration = Duration::from_secs(SESSION_DAYS * 86400);
/// More wrong guesses than this from one address in a minute and its next
/// is not looked at.
const GUESSES_PER_MINUTE: usize = 5;
/// The same for every address together, in case one guesser has many.
const ALL_GUESSES_PER_MINUTE: usize = 60;
const MINUTE: Duration = Duration::from_secs(60);

/// Random bytes as lowercase hex.
pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("the system has a random source");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn hash_password(password: &str) -> Result<String, String> {
    Argon2::default()
        .hash_password(password.as_bytes())
        .map(|h| h.to_string())
        .map_err(|e| format!("could not hash the password: {e}"))
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok(),
        Err(_) => false,
    }
}

/// Compares without stopping at the first difference.
pub fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        diff |= usize::from(a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0));
    }
    diff == 0
}

pub struct Sessions {
    live: Mutex<HashMap<String, Instant>>,
    guesses: Mutex<Guesses>,
}

/// When guesses were made in the last minute: by each address, and by all.
#[derive(Default)]
struct Guesses {
    by: HashMap<IpAddr, VecDeque<Instant>>,
    all: VecDeque<Instant>,
}

fn forget_old(times: &mut VecDeque<Instant>, now: Instant) {
    while times.front().is_some_and(|t| now.duration_since(*t) > MINUTE) {
        times.pop_front();
    }
}

/// Whom a guess is counted against. An IPv6 host has a whole /64 of
/// addresses to guess from, so those count as one; an IPv4 address written
/// as IPv6 counts as itself.
fn guesser(from: IpAddr) -> IpAddr {
    match from.to_canonical() {
        IpAddr::V6(v6) => IpAddr::V6(Ipv6Addr::from_bits(v6.to_bits() & (u128::MAX << 64))),
        v4 => v4,
    }
}

impl Default for Sessions {
    fn default() -> Self {
        Sessions::new()
    }
}

impl Sessions {
    pub fn new() -> Sessions {
        Sessions {
            live: Mutex::new(HashMap::new()),
            guesses: Mutex::new(Guesses::default()),
        }
    }

    /// Starts a session and returns its token.
    pub fn open(&self) -> String {
        let token = random_hex(32);
        let now = Instant::now();
        let mut live = self.live.lock().unwrap();
        live.retain(|_, until| *until > now);
        live.insert(token.clone(), now + SESSION_LIFE);
        token
    }

    pub fn valid(&self, token: &str) -> bool {
        match self.live.lock().unwrap().get(token) {
            Some(until) => *until > Instant::now(),
            None => false,
        }
    }

    pub fn close(&self, token: &str) {
        self.live.lock().unwrap().remove(token);
    }

    /// Whether `from` may make another guess now. If it may, the guess is
    /// counted here and now, as a wrong one, so that guesses arriving
    /// together cannot all get in before the first is found wrong.
    pub fn may_guess(&self, from: IpAddr) -> bool {
        let from = guesser(from);
        let now = Instant::now();
        let mut guesses = self.guesses.lock().unwrap();
        let Guesses { by, all } = &mut *guesses;
        forget_old(all, now);
        by.retain(|_, times| {
            forget_old(times, now);
            !times.is_empty()
        });
        if all.len() >= ALL_GUESSES_PER_MINUTE || by.get(&from).is_some_and(|times| times.len() >= GUESSES_PER_MINUTE) {
            return false;
        }
        all.push_back(now);
        by.entry(from).or_default().push_back(now);
        true
    }

    /// Takes back the count of a guess that turned out right.
    pub fn guessed_right(&self, from: IpAddr) {
        let mut guesses = self.guesses.lock().unwrap();
        guesses.all.pop_back();
        if let Some(times) = guesses.by.get_mut(&guesser(from)) {
            times.pop_back();
        }
    }
}

/// The session token among a request's cookies.
pub fn cookie_token(header: Option<&str>) -> Option<&str> {
    header?.split(';').find_map(|pair| {
        let (name, value) = pair.trim().split_once('=')?;
        (name == COOKIE).then_some(value)
    })
}

/// The header that sets, or with `None` clears, the session cookie.
pub fn set_cookie(token: Option<&str>) -> String {
    match token {
        Some(t) => format!("{COOKIE}={t}; Path=/; Max-Age={}; HttpOnly; SameSite=Strict", SESSION_DAYS * 86400),
        None => format!("{COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_password_matches_its_own_hash_only() {
        let hash = hash_password("correct horse").unwrap();
        assert!(hash.starts_with("$argon2id$"));
        assert!(verify_password("correct horse", &hash));
        assert!(!verify_password("correct horsf", &hash));
        assert!(!verify_password("correct horse", "not a hash"));
    }

    #[test]
    fn a_session_lasts_until_it_is_closed() {
        let sessions = Sessions::new();
        let token = sessions.open();
        assert_eq!(token.len(), 64);
        assert!(sessions.valid(&token));
        assert!(!sessions.valid("someone-else"));
        sessions.close(&token);
        assert!(!sessions.valid(&token));
    }

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    #[test]
    fn wrong_guesses_run_out_for_the_one_guessing() {
        let sessions = Sessions::new();
        for _ in 0..GUESSES_PER_MINUTE {
            assert!(sessions.may_guess(ip("192.168.1.66")));
        }
        assert!(!sessions.may_guess(ip("192.168.1.66")));
        assert!(!sessions.may_guess(ip("::ffff:192.168.1.66")));
        // Someone else is not kept out by that.
        assert!(sessions.may_guess(ip("192.168.1.10")));
        assert!(sessions.may_guess(ip("fd00:0:0:1::10")));
        // One host's many IPv6 addresses count together.
        for i in 0..GUESSES_PER_MINUTE {
            assert!(sessions.may_guess(ip(&format!("fd00::{i:x}"))));
        }
        assert!(!sessions.may_guess(ip("fd00::ffff")));
    }

    #[test]
    fn a_right_guess_is_not_counted() {
        let sessions = Sessions::new();
        for _ in 0..GUESSES_PER_MINUTE * 3 {
            assert!(sessions.may_guess(ip("192.168.1.10")));
            sessions.guessed_right(ip("192.168.1.10"));
        }
        assert!(sessions.guesses.lock().unwrap().all.is_empty());
    }

    #[test]
    fn guesses_made_at_once_do_not_all_get_in() {
        let sessions = Sessions::new();
        let admitted: usize = std::thread::scope(|scope| {
            let threads: Vec<_> = (0..64)
                .map(|_| scope.spawn(|| usize::from(sessions.may_guess(ip("192.168.1.66")))))
                .collect();
            threads.into_iter().map(|t| t.join().unwrap()).sum()
        });
        assert_eq!(admitted, GUESSES_PER_MINUTE);
    }

    #[test]
    fn many_addresses_together_run_out_too() {
        let sessions = Sessions::new();
        let mut admitted = 0;
        for i in 0..ALL_GUESSES_PER_MINUTE * 2 {
            admitted += usize::from(sessions.may_guess(ip(&format!("10.0.{}.{}", i / 250, i % 250 + 1))));
        }
        assert_eq!(admitted, ALL_GUESSES_PER_MINUTE);
        // Only addresses that have guessed are remembered.
        assert_eq!(sessions.guesses.lock().unwrap().by.len(), ALL_GUESSES_PER_MINUTE);
    }

    #[test]
    fn the_token_is_found_among_other_cookies() {
        assert_eq!(cookie_token(Some("theme=dark; crt_session=abc123; x=y")), Some("abc123"));
        assert_eq!(cookie_token(Some("theme=dark")), None);
        assert_eq!(cookie_token(None), None);
        assert!(set_cookie(Some("abc")).contains("HttpOnly"));
    }

    #[test]
    fn same_means_the_same() {
        assert!(same("K7QM-2XPA", "K7QM-2XPA"));
        assert!(!same("K7QM-2XPA", "K7QM-2XPB"));
        assert!(!same("K7QM", "K7QM-2XPA"));
    }
}
