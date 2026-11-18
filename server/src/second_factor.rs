//! The second step of logging in, and the routes its owner enrols and
//! removes factors with. Enrolled factors live in the settings file; what
//! is only half done (a secret not confirmed yet) lives in memory.

use crate::config::SecondFactor;
use crate::{App, admit, auth, oidc, passkey, refuse, reply, same_origin, totp};
use axum::Json;
use axum::extract::{ConnectInfo, State};
use axum::http::header::HOST;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde::Deserialize;
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How long a secret that was handed out waits for its first code.
const ENROL_LIFE: Duration = Duration::from_secs(600);

/// An authenticator secret its owner has seen and not confirmed yet.
pub(crate) struct Enrolling {
    secret: String,
    until: Instant,
}

#[derive(Deserialize)]
pub(crate) struct Code {
    code: String,
}

/// The password again, for changes to how the page is logged in to: a
/// session left open on a desk is not enough for those.
#[derive(Deserialize)]
pub(crate) struct Again {
    pub(crate) password: String,
}

/// Takes what was typed at the second step if it is right: the app's code
/// for a step not used yet, or a recovery code, which is struck off.
fn take(factor: &mut SecondFactor, typed: &str, now: u64) -> bool {
    let digits: String = typed.chars().filter(|c| !c.is_whitespace()).collect();
    let Some(key) = factor.totp_secret.as_deref().and_then(totp::decode_secret) else {
        return false;
    };
    if totp::looks_like_code(&digits) {
        let step = totp::matching_step(&key, &digits, now, factor.totp_last_step);
        if step.is_some() {
            factor.totp_last_step = step;
        }
        return step.is_some();
    }
    let hash = totp::recovery_hash(typed);
    let mut found = None;
    for (i, kept) in factor.recovery.iter().enumerate() {
        if auth::same(kept, &hash) {
            found = Some(i);
        }
    }
    if let Some(i) = found {
        factor.recovery.remove(i);
    }
    found.is_some()
}

/// The second step with a code. A wrong one counts against the address it
/// came from exactly as a wrong password does, and against the password
/// that earned the step, which is good for a few answers, and against the
/// wall as a whole: after enough wrong ones from anywhere, each further
/// answer has to wait.
pub(crate) async fn login_totp(
    State(app): State<Arc<App>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(form): Json<Code>,
) -> Response {
    if !same_origin(&headers) {
        return refuse(StatusCode::FORBIDDEN, "That request came from another site.");
    }
    let Some(pending) = app.pending(&headers) else {
        return refuse(StatusCode::UNAUTHORIZED, crate::PASSWORD_AGAIN);
    };
    let from = app.visitor(from.ip(), &headers);
    if !app.sessions.may_guess(from) {
        return refuse(StatusCode::TOO_MANY_REQUESTS, "Too many wrong tries. Wait a minute.");
    }
    match app.sessions.may_answer(&pending) {
        auth::Step::Go => {}
        refused => {
            // Nothing was looked at, so the address has not guessed.
            app.sessions.guessed_right(from);
            return match refused {
                auth::Step::Wait(secs) => refuse(
                    StatusCode::TOO_MANY_REQUESTS,
                    format!("Too many wrong codes. Try again in {}.", minutes(secs)),
                ),
                _ => refuse(StatusCode::UNAUTHORIZED, crate::PASSWORD_AGAIN),
            };
        }
    }
    let mut wrong = false;
    let taken = app.change(|config| {
        if take(&mut config.second_factor, &form.code, totp::step_now()) {
            Ok(())
        } else {
            wrong = true;
            Err(refuse(StatusCode::FORBIDDEN, "Wrong code."))
        }
    });
    if let Err(no) = taken {
        if wrong && app.sessions.answered_wrong(&pending) {
            return refuse(StatusCode::UNAUTHORIZED, "Too many wrong codes. Enter the password again.");
        }
        return no;
    }
    app.sessions.guessed_right(from);
    app.sessions.answered_right(&pending);
    app.let_in()
}

/// How long to wait, said the way a person would.
fn minutes(secs: u64) -> String {
    match secs.div_ceil(60) {
        0 | 1 => "a minute".into(),
        n => format!("{n} minutes"),
    }
}

/// What is enrolled, for the settings card.
pub(crate) async fn enrolled(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    if let Err(no) = admit(&app, &headers) {
        return no;
    }
    app.second_factor();
    let config = app.config.read().unwrap();
    // Of single sign-on, only that it is on and through whom. It is set up
    // in the settings file, not here.
    let oidc = config.oidc.as_ref().map(|oidc| json!({ "issuer": oidc.issuer.trim() }));
    reply(
        StatusCode::OK,
        json!({
            "totp": config.second_factor.totp_secret.is_some(),
            "recovery": config.second_factor.recovery.len(),
            "passkeys": passkey::listed(&config),
            "passkeys_possible": passkey::possible(&config),
            "oidc": oidc,
            "oidc_possible": oidc::possible(&config),
            "password_login": config.password_login(),
        }),
    )
}

/// What an authenticator app lists the entry under: where the page is.
fn account(app: &App, headers: &HeaderMap) -> String {
    let public = app.config.read().unwrap().public_url.clone();
    let host = match &public {
        Some(url) => url.split_once("://").map_or(url.as_str(), |(_, rest)| rest).trim_end_matches('/'),
        None => headers.get(HOST).and_then(|v| v.to_str().ok()).unwrap_or(""),
    };
    if host.is_empty() { "wall".to_string() } else { host.to_string() }
}

/// Hands out a new secret, as text and as a QR code. It is not saved, and
/// nothing asks for it, until `totp_confirm` has seen a code made from it.
pub(crate) async fn totp_start(
    State(app): State<Arc<App>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(form): Json<Again>,
) -> Response {
    if let Err(no) = admit(&app, &headers) {
        return no;
    }
    let Some(session) = app.session(&headers) else {
        return refuse(StatusCode::UNAUTHORIZED, "Log in first.");
    };
    if let Err(no) = app.check_password(app.visitor(from.ip(), &headers), form.password).await {
        return no;
    }
    if app.config.read().unwrap().second_factor.totp_secret.is_some() {
        return refuse(
            StatusCode::CONFLICT,
            "An authenticator app is already set up. Remove it before setting up another.",
        );
    }
    let secret = totp::new_secret();
    let uri = totp::uri(&secret, &account(&app, &headers));
    let Some(qr) = totp::qr_svg(&uri) else {
        return refuse(StatusCode::INTERNAL_SERVER_ERROR, "Could not draw the QR code.");
    };
    let now = Instant::now();
    let mut enrolling = app.enrolling.lock().unwrap();
    enrolling.retain(|_, e| e.until > now);
    enrolling.insert(
        session,
        Enrolling {
            secret: secret.clone(),
            until: now + ENROL_LIFE,
        },
    );
    reply(StatusCode::OK, json!({ "secret": secret, "uri": uri, "qr": qr }))
}

/// Saves the secret handed out by `totp_start` once a code shows the app
/// has it, and answers the recovery codes, this once. The code is used up
/// by that, as it would be by a log-in. If this is the first second
/// factor, every other session is closed: they were opened by the password
/// alone, which from now on is not enough.
pub(crate) async fn totp_confirm(State(app): State<Arc<App>>, headers: HeaderMap, Json(form): Json<Code>) -> Response {
    if let Err(no) = admit(&app, &headers) {
        return no;
    }
    let Some(session) = app.session(&headers) else {
        return refuse(StatusCode::UNAUTHORIZED, "Log in first.");
    };
    let secret = {
        let enrolling = app.enrolling.lock().unwrap();
        enrolling
            .get(&session)
            .filter(|e| e.until > Instant::now())
            .map(|e| e.secret.clone())
    };
    let Some(secret) = secret else {
        return refuse(StatusCode::CONFLICT, "That took too long. Start setting up the app again.");
    };
    let digits: String = form.code.chars().filter(|c| !c.is_whitespace()).collect();
    let step = totp::decode_secret(&secret).and_then(|key| totp::matching_step(&key, &digits, totp::step_now(), None));
    let Some(step) = step else {
        return refuse(
            StatusCode::FORBIDDEN,
            "That is not the code the app shows now. Nothing was saved; try the next code.",
        );
    };
    let codes = totp::new_recovery_codes();
    let saved = app.change(|config| {
        // Two cards racing: the first one in wins.
        if config.second_factor.totp_secret.is_some() {
            return Err(refuse(StatusCode::CONFLICT, "An authenticator app is already set up."));
        }
        let first = !config.second_factor.enrolled();
        config.second_factor.totp_secret = Some(secret);
        config.second_factor.totp_last_step = Some(step);
        config.second_factor.recovery = codes.iter().map(|code| totp::recovery_hash(code)).collect();
        Ok(first)
    });
    app.enrolling.lock().unwrap().remove(&session);
    match saved {
        Ok(first) => {
            if first {
                app.sessions.close_others(&session);
            }
            reply(StatusCode::OK, json!({ "ok": true, "recovery": codes }))
        }
        Err(no) => no,
    }
}

/// Removes the authenticator app and the recovery codes that stand in for
/// it.
pub(crate) async fn totp_remove(
    State(app): State<Arc<App>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(form): Json<Again>,
) -> Response {
    if let Err(no) = admit(&app, &headers) {
        return no;
    }
    if let Err(no) = app.check_password(app.visitor(from.ip(), &headers), form.password).await {
        return no;
    }
    let removed = app.change(|config| {
        if config.second_factor.totp_secret.is_none() {
            return Err(refuse(StatusCode::CONFLICT, "No authenticator app is set up."));
        }
        config.second_factor.totp_secret = None;
        config.second_factor.totp_last_step = None;
        config.second_factor.recovery.clear();
        Ok(())
    });
    match removed {
        Ok(()) => reply(StatusCode::OK, json!({ "ok": true })),
        Err(no) => no,
    }
}

/// Makes a fresh set of recovery codes in place of the old, and answers
/// them, this once.
pub(crate) async fn recovery_renew(
    State(app): State<Arc<App>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(form): Json<Again>,
) -> Response {
    if let Err(no) = admit(&app, &headers) {
        return no;
    }
    if let Err(no) = app.check_password(app.visitor(from.ip(), &headers), form.password).await {
        return no;
    }
    let codes = totp::new_recovery_codes();
    let saved = app.change(|config| {
        if config.second_factor.totp_secret.is_none() {
            return Err(refuse(
                StatusCode::CONFLICT,
                "Recovery codes stand in for an authenticator app. Set one up first.",
            ));
        }
        config.second_factor.recovery = codes.iter().map(|code| totp::recovery_hash(code)).collect();
        Ok(())
    });
    match saved {
        Ok(()) => reply(StatusCode::OK, json!({ "ok": true, "recovery": codes })),
        Err(no) => no,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const NOW: u64 = 37037036;

    fn factor(recovery: &[&str]) -> SecondFactor {
        SecondFactor {
            totp_secret: Some(SECRET.into()),
            totp_last_step: None,
            recovery: recovery.iter().map(|code| totp::recovery_hash(code)).collect(),
            passkeys: Vec::new(),
        }
    }

    fn code(step: u64) -> String {
        totp::code(&totp::decode_secret(SECRET).unwrap(), step)
    }

    #[test]
    fn an_app_code_is_taken_once() {
        let mut factor = factor(&[]);
        assert!(take(&mut factor, &format!(" {} ", code(NOW)), NOW));
        assert_eq!(factor.totp_last_step, Some(NOW));
        assert!(!take(&mut factor, &code(NOW), NOW));
        assert!(!take(&mut factor, &code(NOW - 1), NOW));
        assert!(take(&mut factor, &code(NOW + 1), NOW));
        assert_eq!(factor.totp_last_step, Some(NOW + 1));
    }

    #[test]
    fn a_recovery_code_is_struck_off_when_used() {
        let mut factor = factor(&["K7QM-2XPA-9BCD", "ABCD-EFGH-JKLM"]);
        assert!(!take(&mut factor, "K7QM-2XPA-9BCE", NOW));
        assert_eq!(factor.recovery.len(), 2);
        assert!(take(&mut factor, "k7qm2xpa9bcd", NOW));
        assert_eq!(factor.recovery, vec![totp::recovery_hash("ABCD-EFGH-JKLM")]);
        assert!(!take(&mut factor, "K7QM-2XPA-9BCD", NOW));
        // It leaves the app's codes as they were.
        assert_eq!(factor.totp_last_step, None);
    }

    #[test]
    fn a_wait_is_said_in_minutes() {
        assert_eq!(minutes(1), "a minute");
        assert_eq!(minutes(60), "a minute");
        assert_eq!(minutes(61), "2 minutes");
        assert_eq!(minutes(3600), "60 minutes");
    }

    #[test]
    fn nothing_is_taken_where_nothing_is_enrolled() {
        let mut none = SecondFactor::default();
        assert!(!take(&mut none, &code(NOW), NOW));
        assert!(!take(&mut none, "", NOW));
        // Left-over recovery codes open nothing without the app they stand in for.
        none.recovery = vec![totp::recovery_hash("K7QM-2XPA-9BCD")];
        assert!(!take(&mut none, "K7QM-2XPA-9BCD", NOW));
    }
}
