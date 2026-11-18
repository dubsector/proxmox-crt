//! Who may use the page. The bridge can open consoles, so the page asks for
//! a password and the bridge remembers who gave it by a cookie. Where a
//! second factor is enrolled, the password earns only a short-lived cookie
//! that lets its holder go on to the second step. A sign-in through a
//! provider has a short-lived cookie of its own while it is away there.

use argon2::Argon2;
use argon2::password_hash::phc::PasswordHash;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv6Addr};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::watch;

pub const COOKIE: &str = "crt_session";
pub const SESSION_DAYS: u64 = 30;
/// The cookie of someone who gave the password and still owes the second
/// step. It opens nothing but the routes of that step.
pub const PENDING_COOKIE: &str = "crt_pending";
pub const PENDING_SECS: u64 = 300;
/// The cookie of a sign-in that has gone to the single sign-on provider
/// and is to come back.
pub const OIDC_COOKIE: &str = "crt_oidc";
pub const OIDC_SECS: u64 = 600;
pub const MIN_PASSWORD: usize = 8;

const SESSION_LIFE: Duration = Duration::from_secs(SESSION_DAYS * 86400);
const PENDING_LIFE: Duration = Duration::from_secs(PENDING_SECS);
/// More wrong guesses than this from one address in a minute and its next
/// is not looked at.
const GUESSES_PER_MINUTE: usize = 5;
/// The same for every address together, in case one guesser has many.
const ALL_GUESSES_PER_MINUTE: usize = 60;
const MINUTE: Duration = Duration::from_secs(60);
/// How many answers one right password is good for at the second step.
/// After as many wrong ones the password is asked for again.
const ANSWERS_PER_PASSWORD: u32 = 3;
/// Wrong answers at the second step, from anywhere, before each further
/// answer has to wait: a minute for the first, and twice as long each time
/// after. Whoever gets as far as the second step has the password, so six
/// digits are all that is left to guess, and five tries a minute from each
/// of many addresses would find them in days.
const FREE_WRONG_ANSWERS: u32 = 10;
const LONGEST_WAIT: Duration = Duration::from_secs(3600);

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
    /// Told each time a session is closed, so that what it had open can be
    /// closed with it.
    closed: watch::Sender<()>,
    /// Who gave the password and has yet to give the second factor.
    pending: Mutex<HashMap<String, Pending>>,
    guesses: Mutex<Guesses>,
    answers: Mutex<Answers>,
}

/// Leave to go on to the second step.
struct Pending {
    until: Instant,
    /// How many answers it has been used for.
    answers: u32,
}

/// The wrong answers at the second step since the last right one, whoever
/// gave them, and until when the next has to wait.
#[derive(Default)]
struct Answers {
    wrong: u32,
    wait_until: Option<Instant>,
}

/// Whether an answer at the second step is looked at.
#[derive(Debug, PartialEq)]
pub enum Step {
    Go,
    /// The password has to be given again first.
    PasswordAgain,
    /// Too many wrong answers: none is looked at for this many seconds.
    Wait(u64),
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
            closed: watch::channel(()).0,
            pending: Mutex::new(HashMap::new()),
            guesses: Mutex::new(Guesses::default()),
            answers: Mutex::new(Answers::default()),
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
        self.closed.send_replace(());
    }

    /// Closes every session but `keep`. A session opened by the password
    /// alone is not left open once more than the password is asked for.
    pub fn close_others(&self, keep: &str) {
        self.live.lock().unwrap().retain(|token, _| token == keep);
        self.closed.send_replace(());
    }

    /// Changes each time a session is closed. A socket that belongs to a
    /// session watches this, and looks whether its own is still good.
    pub fn closings(&self) -> watch::Receiver<()> {
        self.closed.subscribe()
    }

    /// Notes that the password was right and returns the token that admits
    /// to the second step, for a few minutes and a few answers.
    pub fn open_pending(&self) -> String {
        self.open_pending_at(Instant::now())
    }

    fn open_pending_at(&self, now: Instant) -> String {
        let token = random_hex(32);
        let mut pending = self.pending.lock().unwrap();
        pending.retain(|_, p| p.until > now);
        pending.insert(
            token.clone(),
            Pending {
                until: now + PENDING_LIFE,
                answers: 0,
            },
        );
        token
    }

    pub fn pending_valid(&self, token: &str) -> bool {
        match self.pending.lock().unwrap().get(token) {
            Some(pending) => pending.until > Instant::now(),
            None => false,
        }
    }

    pub fn close_pending(&self, token: &str) {
        self.pending.lock().unwrap().remove(token);
    }

    /// Whether a code may be tried at the second step that `token` admits
    /// to. If it may, it is counted here and now, as a wrong one, for the
    /// same reason a password guess is.
    pub fn may_answer(&self, token: &str) -> Step {
        self.may_answer_at(token, Instant::now())
    }

    fn may_answer_at(&self, token: &str, now: Instant) -> Step {
        let mut answers = self.answers.lock().unwrap();
        if let Some(until) = answers.wait_until.filter(|until| *until > now) {
            let left = until - now;
            return Step::Wait(left.as_secs() + u64::from(left.subsec_nanos() > 0));
        }
        let mut pending = self.pending.lock().unwrap();
        match pending.get_mut(token) {
            Some(leave) if leave.until > now && leave.answers < ANSWERS_PER_PASSWORD => leave.answers += 1,
            _ => {
                pending.remove(token);
                return Step::PasswordAgain;
            }
        }
        answers.wrong += 1;
        if answers.wrong > FREE_WRONG_ANSWERS {
            let doublings = (answers.wrong - FREE_WRONG_ANSWERS - 1).min(16);
            answers.wait_until = Some(now + (MINUTE * 2u32.pow(doublings)).min(LONGEST_WAIT));
        }
        Step::Go
    }

    /// Notes that the answer was wrong. True if that was the last one
    /// `token` was good for, which is then closed.
    pub fn answered_wrong(&self, token: &str) -> bool {
        let mut pending = self.pending.lock().unwrap();
        let used_up = pending.get(token).is_none_or(|leave| leave.answers >= ANSWERS_PER_PASSWORD);
        if used_up {
            pending.remove(token);
        }
        used_up
    }

    /// Notes that the second step was passed, by a code or otherwise. The
    /// wrong answers before it are forgotten: only the owner gets here.
    pub fn answered_right(&self, token: &str) {
        *self.answers.lock().unwrap() = Answers::default();
        self.close_pending(token);
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

/// The value of the cookie called `name` among a request's cookies.
pub fn cookie_value<'a>(header: Option<&'a str>, name: &str) -> Option<&'a str> {
    header?.split(';').find_map(|pair| {
        let (found, value) = pair.trim().split_once('=')?;
        (found == name).then_some(value)
    })
}

/// The session token among a request's cookies.
pub fn cookie_token(header: Option<&str>) -> Option<&str> {
    cookie_value(header, COOKIE)
}

fn cookie(name: &str, token: Option<&str>, life: u64, same_site: &str, secure: bool) -> String {
    let (value, age) = match token {
        Some(t) => (t, life),
        None => ("", 0),
    };
    let secure = if secure { "; Secure" } else { "" };
    format!("{name}={value}; Path=/; Max-Age={age}; HttpOnly; SameSite={same_site}{secure}")
}

/// The header that sets, or with `None` clears, the session cookie. With
/// `secure` the browser sends it over https only.
pub fn set_cookie(token: Option<&str>, secure: bool) -> String {
    cookie(COOKIE, token, SESSION_DAYS * 86400, "Strict", secure)
}

/// The same for the cookie of the second step.
pub fn set_pending_cookie(token: Option<&str>, secure: bool) -> String {
    cookie(PENDING_COOKIE, token, PENDING_SECS, "Strict", secure)
}

/// The same for the cookie of a sign-in that is away at the provider. The
/// provider sends the browser back from its own site, and a strict cookie
/// stays behind on such a trip, so this one is lax: it comes along when
/// the browser is led here, and still not on anything another site's page
/// fetches or posts.
pub fn set_oidc_cookie(token: Option<&str>, secure: bool) -> String {
    cookie(OIDC_COOKIE, token, OIDC_SECS, "Lax", secure)
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
        assert_eq!(cookie_value(Some("crt_pending=p1; crt_session=s1"), PENDING_COOKIE), Some("p1"));
        assert_eq!(cookie_token(Some("crt_pending=p1")), None);
    }

    #[test]
    fn the_cookies_are_kept_from_scripts_and_other_sites() {
        assert_eq!(
            set_cookie(Some("abc"), false),
            "crt_session=abc; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict"
        );
        assert_eq!(
            set_cookie(None, false),
            "crt_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict"
        );
        assert!(set_cookie(Some("abc"), true).ends_with("; SameSite=Strict; Secure"));
        assert_eq!(
            set_pending_cookie(Some("abc"), true),
            "crt_pending=abc; Path=/; Max-Age=300; HttpOnly; SameSite=Strict; Secure"
        );
        // All but the one that has to come back from the provider's site.
        assert_eq!(
            set_oidc_cookie(Some("abc"), true),
            "crt_oidc=abc; Path=/; Max-Age=600; HttpOnly; SameSite=Lax; Secure"
        );
    }

    #[test]
    fn the_password_alone_is_not_a_session() {
        let sessions = Sessions::new();
        let token = sessions.open_pending();
        assert!(sessions.pending_valid(&token));
        assert!(!sessions.valid(&token));
        assert!(!sessions.pending_valid(&sessions.open()));
        sessions.close_pending(&token);
        assert!(!sessions.pending_valid(&token));
    }

    #[test]
    fn a_right_password_is_good_for_a_few_answers_only() {
        let sessions = Sessions::new();
        let token = sessions.open_pending();
        for left in (0..ANSWERS_PER_PASSWORD).rev() {
            assert_eq!(sessions.may_answer(&token), Step::Go);
            assert_eq!(sessions.answered_wrong(&token), left == 0);
        }
        assert!(!sessions.pending_valid(&token));
        assert_eq!(sessions.may_answer(&token), Step::PasswordAgain);
        assert_eq!(sessions.may_answer("someone-else"), Step::PasswordAgain);
        // Answers that arrive together are not all looked at either.
        let token = sessions.open_pending();
        let looked_at: u32 = std::thread::scope(|scope| {
            let threads: Vec<_> = (0..16)
                .map(|_| scope.spawn(|| u32::from(sessions.may_answer(&token) == Step::Go)))
                .collect();
            threads.into_iter().map(|t| t.join().unwrap()).sum()
        });
        assert_eq!(looked_at, ANSWERS_PER_PASSWORD);
    }

    #[test]
    fn wrong_answers_from_anywhere_make_the_next_one_wait_longer_each_time() {
        let sessions = Sessions::new();
        let mut now = Instant::now();
        let wrong = |now: Instant| {
            let token = sessions.open_pending_at(now);
            let step = sessions.may_answer_at(&token, now);
            sessions.answered_wrong(&token);
            step
        };
        for _ in 0..FREE_WRONG_ANSWERS {
            assert_eq!(wrong(now), Step::Go);
        }
        // The next is still looked at, and after it nothing is for a
        // minute, then two, then four, and never longer than an hour.
        for wait in [60, 120, 240, 480, 960, 1920, 3600, 3600] {
            assert_eq!(wrong(now), Step::Go);
            assert_eq!(wrong(now), Step::Wait(wait));
            now += Duration::from_secs(wait - 1);
            assert_eq!(wrong(now), Step::Wait(1));
            now += Duration::from_secs(1);
        }
        // A refusal used nothing up: the password is still good for its
        // answers, and the right one clears the count.
        let token = sessions.open_pending_at(now);
        assert_eq!(sessions.may_answer_at(&token, now), Step::Go);
        assert_eq!(sessions.may_answer_at(&token, now), Step::Wait(3600));
        assert_eq!(sessions.pending.lock().unwrap()[&token].answers, 1);
        sessions.answered_right(&token);
        assert!(!sessions.pending_valid(&token));
        for _ in 0..FREE_WRONG_ANSWERS {
            assert_eq!(wrong(now), Step::Go);
        }
    }

    #[test]
    fn closing_the_others_leaves_one_session_and_says_so() {
        let sessions = Sessions::new();
        let (mine, other) = (sessions.open(), sessions.open());
        let mut closings = sessions.closings();
        assert!(!closings.has_changed().unwrap());
        sessions.close_others(&mine);
        assert!(sessions.valid(&mine));
        assert!(!sessions.valid(&other));
        assert!(closings.has_changed().unwrap());
        closings.mark_unchanged();
        sessions.close(&mine);
        assert!(closings.has_changed().unwrap());
    }

    #[test]
    fn same_means_the_same() {
        assert!(same("K7QM-2XPA", "K7QM-2XPA"));
        assert!(!same("K7QM-2XPA", "K7QM-2XPB"));
        assert!(!same("K7QM", "K7QM-2XPA"));
    }
}
