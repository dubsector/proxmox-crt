//! Passkeys as the second step after the password, and the routes their
//! owner adds and removes them with. The WebAuthn library (webauthn-rs)
//! makes the challenges and checks every answer; this decides who may ask,
//! keeps each challenge until it is answered, and saves the keys.

use crate::config::{Config, Passkey};
use crate::{App, admit, auth, refuse, reply, same_origin};
use axum::Json;
use axum::extract::{ConnectInfo, Path as UrlPath, State};
use axum::http::header::ORIGIN;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use webauthn_rs::prelude::{
    PublicKeyCredential, RegisterPublicKeyCredential, SecurityKey, SecurityKeyAuthentication, SecurityKeyRegistration, Url, Uuid, Webauthn,
    WebauthnBuilder,
};
use webauthn_rs_proto::ResidentKeyRequirement;

/// How long a challenge waits for its answer.
const CHALLENGE_LIFE: Duration = Duration::from_secs(300);
/// More passkeys than this is someone filling the settings file.
const MOST: usize = 10;
const LONGEST_NAME: usize = 40;
const NEEDS_HTTPS: &str = "Passkeys need the page to be reached over https at its public address; set public_url";
/// The one user there is. A passkey is made for a user of a site, and the
/// same number each time lets an authenticator replace the passkey it
/// already holds for this wall rather than collect them.
const OWNER: Uuid = Uuid::from_u128(0x70726f78_6d6f_4863_8274_6f776e657231);

/// A passkey being added: the challenge its answer has to carry, and the
/// name it was given.
struct Adding {
    state: SecurityKeyRegistration,
    name: String,
    until: Instant,
}

/// A passkey being asked for at the second step.
struct Asking {
    state: SecurityKeyAuthentication,
    until: Instant,
}

/// The challenges that are out. Each is kept under the cookie it was
/// given to, a session's or a second step's, and is taken away by the
/// first answer, right or wrong, so none can be answered twice.
#[derive(Default)]
pub(crate) struct Ceremonies {
    adding: Mutex<HashMap<String, Adding>>,
    asking: Mutex<HashMap<String, Asking>>,
}

impl Ceremonies {
    /// Forgets what was given to a cookie that is no longer good.
    pub(crate) fn forget(&self, token: &str) {
        self.adding.lock().unwrap().remove(token);
        self.asking.lock().unwrap().remove(token);
    }
}

/// The relying party, as WebAuthn calls the site: its name is the host of
/// `public_url` and its origin is `public_url`'s. `None` where a browser
/// would not allow passkeys: no `public_url`, plain http anywhere but on
/// the machine itself, or a bare address in place of a name.
fn relying_party(config: &Config) -> Option<(Webauthn, Url)> {
    if !config.trusted_origin() {
        return None;
    }
    let url = Url::parse(config.public_url.as_deref()?.trim()).ok()?;
    let site = WebauthnBuilder::new(url.domain()?, &url)
        .ok()?
        .rp_name("proxmox-crt")
        .build()
        .ok()?;
    Some((site, url))
}

/// Whether passkeys can be used at this bridge's public address.
pub(crate) fn possible(config: &Config) -> bool {
    relying_party(config).is_some()
}

/// The relying party for a request, which has to have come from the page
/// at the public address: a passkey made for one address answers at no
/// other.
fn site(app: &App, headers: &HeaderMap) -> Result<Webauthn, Response> {
    let Some((site, url)) = relying_party(&app.config.read().unwrap()) else {
        return Err(refuse(StatusCode::CONFLICT, NEEDS_HTTPS));
    };
    if let Some(origin) = headers.get(ORIGIN) {
        let from = origin.to_str().ok().and_then(|o| Url::parse(o).ok());
        if from.is_none_or(|from| from.origin() != url.origin()) {
            return Err(refuse(StatusCode::FORBIDDEN, NEEDS_HTTPS));
        }
    }
    Ok(site)
}

/// A saved passkey as the library reads it.
fn key(passkey: &Passkey) -> Option<SecurityKey> {
    serde_json::from_str(&passkey.credential).ok()
}

/// Whether every passkey in the settings can be read.
pub(crate) fn readable(config: &Config) -> bool {
    config.second_factor.passkeys.iter().all(|p| key(p).is_some())
}

fn keys(config: &Config) -> Vec<SecurityKey> {
    config.second_factor.passkeys.iter().filter_map(key).collect()
}

/// What the page is told of a passkey.
pub(crate) fn listed(config: &Config) -> Vec<serde_json::Value> {
    let passkeys = config.second_factor.passkeys.iter();
    passkeys.map(|p| json!({ "id": p.id, "name": p.name, "added": p.added })).collect()
}

/// The second step with a passkey, first half: the challenge for one of
/// the saved passkeys to sign.
pub(crate) async fn login_start(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    if !same_origin(&headers) {
        return refuse(StatusCode::FORBIDDEN, "That request came from another site.");
    }
    let Some(pending) = app.pending(&headers) else {
        return refuse(StatusCode::UNAUTHORIZED, crate::PASSWORD_AGAIN);
    };
    let site = match site(&app, &headers) {
        Ok(site) => site,
        Err(no) => return no,
    };
    app.second_factor();
    let keys = keys(&app.config.read().unwrap());
    if keys.is_empty() {
        return refuse(StatusCode::CONFLICT, "No passkey is set up.");
    }
    let Ok((mut options, state)) = site.start_securitykey_authentication(&keys) else {
        return refuse(StatusCode::INTERNAL_SERVER_ERROR, "Could not ask for a passkey.");
    };
    // The library hints at a key on a stick; a phone or this computer
    // will do as well.
    options.public_key.hints = None;
    let now = Instant::now();
    let mut asking = app.passkeys.asking.lock().unwrap();
    asking.retain(|_, a| a.until > now);
    asking.insert(
        pending,
        Asking {
            state,
            until: now + CHALLENGE_LIFE,
        },
    );
    reply(StatusCode::OK, json!({ "ok": true, "options": options }))
}

#[derive(Deserialize)]
pub(crate) struct Signed {
    credential: PublicKeyCredential,
}

/// Second half: the signed challenge. A wrong answer counts against the
/// address it came from as a wrong password does.
pub(crate) async fn login_finish(
    State(app): State<Arc<App>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(form): Json<Signed>,
) -> Response {
    if !same_origin(&headers) {
        return refuse(StatusCode::FORBIDDEN, "That request came from another site.");
    }
    let Some(pending) = app.pending(&headers) else {
        return refuse(StatusCode::UNAUTHORIZED, crate::PASSWORD_AGAIN);
    };
    let site = match site(&app, &headers) {
        Ok(site) => site,
        Err(no) => return no,
    };
    let asked = app.passkeys.asking.lock().unwrap().remove(&pending);
    let Some(asked) = asked.filter(|a| a.until > Instant::now()) else {
        return refuse(StatusCode::CONFLICT, "That took too long. Ask for the passkey again.");
    };
    if !app.sessions.may_guess(from.ip()) {
        return refuse(StatusCode::TOO_MANY_REQUESTS, "Too many wrong tries. Wait a minute.");
    }
    // The library checks the challenge, the address the browser signed
    // for, the signature, and that the passkey's count of uses has not
    // gone backwards, which it would for a copy.
    let Ok(result) = site.finish_securitykey_authentication(&form.credential, &asked.state) else {
        return refuse(StatusCode::FORBIDDEN, "That passkey was not accepted.");
    };
    // The passkey may have been removed since the challenge went out, by
    // its owner or from the settings file.
    app.second_factor();
    let find = |config: &Config| {
        let passkeys = config.second_factor.passkeys.iter();
        passkeys
            .enumerate()
            .find_map(|(i, p)| key(p).filter(|k| k.cred_id() == result.cred_id()).map(|k| (i, k)))
    };
    if find(&app.config.read().unwrap()).is_none() {
        return refuse(StatusCode::FORBIDDEN, "That passkey was not accepted.");
    }
    // Its count of uses is saved, so that an older count is known for one.
    // Passkeys that keep no count leave the file alone.
    if result.needs_update() {
        let saved = app.change(|config| {
            let Some((i, mut key)) = find(config) else {
                return Err(refuse(StatusCode::FORBIDDEN, "That passkey was not accepted."));
            };
            key.update_credential(&result);
            match serde_json::to_string(&key) {
                Ok(credential) => config.second_factor.passkeys[i].credential = credential,
                Err(_) => return Err(refuse(StatusCode::INTERNAL_SERVER_ERROR, "Could not save the passkey.")),
            }
            Ok(())
        });
        if let Err(no) = saved {
            return no;
        }
    }
    app.sessions.guessed_right(from.ip());
    app.sessions.answered_right(&pending);
    app.let_in()
}

#[derive(Deserialize)]
pub(crate) struct Add {
    password: String,
    #[serde(default)]
    name: String,
}

/// Adding a passkey, first half: the challenge for a new passkey to sign.
/// Nothing is saved until `add_finish` has seen it signed.
pub(crate) async fn add_start(
    State(app): State<Arc<App>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(form): Json<Add>,
) -> Response {
    if let Err(no) = admit(&app, &headers) {
        return no;
    }
    let Some(session) = app.session(&headers) else {
        return refuse(StatusCode::UNAUTHORIZED, "Log in first.");
    };
    let site = match site(&app, &headers) {
        Ok(site) => site,
        Err(no) => return no,
    };
    if let Err(no) = app.check_password(from.ip(), form.password).await {
        return no;
    }
    let name = match form.name.trim() {
        "" => "Passkey",
        name => name,
    };
    if name.chars().count() > LONGEST_NAME || name.chars().any(char::is_control) {
        return refuse(
            StatusCode::BAD_REQUEST,
            format!("The name can have up to {LONGEST_NAME} characters."),
        );
    }
    let have = keys(&app.config.read().unwrap());
    if have.len() >= MOST {
        return refuse(
            StatusCode::CONFLICT,
            format!("There are {MOST} passkeys already. Remove one first."),
        );
    }
    // An authenticator that holds one of these already says so in place
    // of making a second.
    let exclude = have.iter().map(|k| k.cred_id().clone()).collect();
    let Ok((mut options, state)) = site.start_securitykey_registration(OWNER, "owner", "proxmox-crt", Some(exclude), None, None) else {
        return refuse(StatusCode::INTERNAL_SERVER_ERROR, "Could not ask for a passkey.");
    };
    // The library asks for a key on a stick that keeps nothing. A phone
    // or this computer will do as well, and may keep the passkey where
    // its owner can see and delete it.
    options.public_key.hints = None;
    if let Some(wanted) = &mut options.public_key.authenticator_selection {
        wanted.resident_key = Some(ResidentKeyRequirement::Preferred);
    }
    // It also asks that the passkey never answer without a PIN or a
    // fingerprint. A browser refuses to ask that of a passkey that may be
    // kept unless every use is to demand one, and here one is preferred,
    // not demanded: the password came first.
    if let Some(extensions) = &mut options.public_key.extensions {
        extensions.cred_protect = None;
    }
    let now = Instant::now();
    let mut adding = app.passkeys.adding.lock().unwrap();
    adding.retain(|_, a| a.until > now);
    adding.insert(
        session,
        Adding {
            state,
            name: name.to_string(),
            until: now + CHALLENGE_LIFE,
        },
    );
    reply(StatusCode::OK, json!({ "ok": true, "options": options }))
}

#[derive(Deserialize)]
pub(crate) struct Made {
    credential: RegisterPublicKeyCredential,
}

/// Second half: the new passkey's public key, signed over the challenge.
/// The password was asked for when the challenge went out. If this is the
/// first second factor, every other session is closed, as when the
/// authenticator app is the first.
pub(crate) async fn add_finish(State(app): State<Arc<App>>, headers: HeaderMap, Json(form): Json<Made>) -> Response {
    if let Err(no) = admit(&app, &headers) {
        return no;
    }
    let Some(session) = app.session(&headers) else {
        return refuse(StatusCode::UNAUTHORIZED, "Log in first.");
    };
    let site = match site(&app, &headers) {
        Ok(site) => site,
        Err(no) => return no,
    };
    let added = app.passkeys.adding.lock().unwrap().remove(&session);
    let Some(added) = added.filter(|a| a.until > Instant::now()) else {
        return refuse(StatusCode::CONFLICT, "That took too long. Start adding the passkey again.");
    };
    let key = match site.finish_securitykey_registration(&form.credential, &added.state) {
        Ok(key) => key,
        Err(e) => return refuse(StatusCode::BAD_REQUEST, format!("That passkey could not be added: {e}.")),
    };
    let Ok(credential) = serde_json::to_string(&key) else {
        return refuse(StatusCode::INTERNAL_SERVER_ERROR, "Could not save the passkey.");
    };
    let passkey = Passkey {
        id: auth::random_hex(8),
        name: added.name,
        added: SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()),
        credential,
    };
    let told = json!({ "id": passkey.id, "name": passkey.name, "added": passkey.added });
    let saved = app.change(|config| {
        // Two cards racing: neither adds the same passkey twice, nor one
        // too many.
        let have = keys(config);
        if have.iter().any(|k| k.cred_id() == key.cred_id()) {
            return Err(refuse(StatusCode::CONFLICT, "That passkey is already added."));
        }
        if have.len() >= MOST {
            return Err(refuse(
                StatusCode::CONFLICT,
                format!("There are {MOST} passkeys already. Remove one first."),
            ));
        }
        let first = !config.second_factor.enrolled();
        config.second_factor.passkeys.push(passkey);
        Ok(first)
    });
    match saved {
        Ok(first) => {
            if first {
                app.sessions.close_others(&session);
            }
            reply(StatusCode::OK, json!({ "ok": true, "passkey": told }))
        }
        Err(no) => no,
    }
}

/// Removes the passkey the bridge calls `id`.
pub(crate) async fn remove(
    State(app): State<Arc<App>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    UrlPath(id): UrlPath<String>,
    Json(form): Json<crate::second_factor::Again>,
) -> Response {
    if let Err(no) = admit(&app, &headers) {
        return no;
    }
    if let Err(no) = app.check_password(from.ip(), form.password).await {
        return no;
    }
    let removed = app.change(|config| {
        let passkeys = &mut config.second_factor.passkeys;
        let Some(i) = passkeys.iter().position(|p| p.id == id) else {
            return Err(refuse(StatusCode::NOT_FOUND, "There is no such passkey."));
        };
        passkeys.remove(i);
        Ok(())
    });
    match removed {
        Ok(()) => reply(StatusCode::OK, json!({ "ok": true })),
        Err(no) => no,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(url: &str) -> Config {
        let mut config = Config::new();
        config.public_url = Some(url.into());
        config
    }

    #[test]
    fn passkeys_need_a_name_a_browser_trusts() {
        assert!(!possible(&Config::new()));
        for (url, ok) in [
            ("https://crt.example.com", true),
            ("https://crt.example.com:8443/", true),
            ("http://localhost:8086", true),
            ("http://crt.example.com", false),
            // A passkey belongs to a name, and an address is not one.
            ("https://192.168.1.20", false),
            ("https://[fd00::20]", false),
            ("https://", false),
        ] {
            assert_eq!(possible(&at(url)), ok, "{url}");
        }
    }

    #[test]
    fn the_site_is_named_after_the_public_address() {
        let (site, url) = relying_party(&at(" https://crt.example.com/ ")).unwrap();
        assert_eq!(url.origin().ascii_serialization(), "https://crt.example.com");
        let (options, _) = site
            .start_securitykey_registration(OWNER, "owner", "proxmox-crt", None, None, None)
            .unwrap();
        assert_eq!(options.public_key.rp.id, "crt.example.com");
        assert_eq!(options.public_key.rp.name, "proxmox-crt");
    }

    #[test]
    fn a_passkey_that_cannot_be_read_is_noticed() {
        let mut config = Config::new();
        assert!(readable(&config));
        config.second_factor.passkeys.push(Passkey {
            id: "0123456789abcdef".into(),
            name: "Phone".into(),
            added: 0,
            credential: "{}".into(),
        });
        assert!(!readable(&config));
        assert!(keys(&config).is_empty());
        assert_eq!(
            listed(&config),
            vec![json!({ "id": "0123456789abcdef", "name": "Phone", "added": 0 })]
        );
    }
}
