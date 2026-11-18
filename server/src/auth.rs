//! Who may use the page. The bridge can open consoles, so the page asks for
//! a password and the bridge remembers who gave it by a cookie.

use argon2::Argon2;
use argon2::password_hash::phc::PasswordHash;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const COOKIE: &str = "crt_session";
pub const SESSION_DAYS: u64 = 30;
pub const MIN_PASSWORD: usize = 8;

const SESSION_LIFE: Duration = Duration::from_secs(SESSION_DAYS * 86400);
/// More wrong guesses than this in a minute and the next is not looked at.
const GUESSES_PER_MINUTE: usize = 5;

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
    wrong: Mutex<VecDeque<Instant>>,
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
            wrong: Mutex::new(VecDeque::new()),
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

    /// Whether another guess may be made now.
    pub fn may_guess(&self) -> bool {
        let now = Instant::now();
        let mut wrong = self.wrong.lock().unwrap();
        while wrong.front().is_some_and(|t| now.duration_since(*t) > Duration::from_secs(60)) {
            wrong.pop_front();
        }
        wrong.len() < GUESSES_PER_MINUTE
    }

    pub fn guessed_wrong(&self) {
        self.wrong.lock().unwrap().push_back(Instant::now());
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

    #[test]
    fn wrong_guesses_run_out() {
        let sessions = Sessions::new();
        for _ in 0..GUESSES_PER_MINUTE {
            assert!(sessions.may_guess());
            sessions.guessed_wrong();
        }
        assert!(!sessions.may_guess());
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
