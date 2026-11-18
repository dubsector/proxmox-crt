//! The bridge end to end, against the mock Proxmox host: setting up,
//! logging in, the second step after the password by code or by passkey,
//! single sign-on against a stand-in provider, the feed of readings, and
//! typing into a console.

#[path = "../examples/mock_pve.rs"]
mod mock_pve;

use data_encoding::{BASE64, BASE64URL_NOPAD};
use futures_util::{SinkExt, StreamExt};
use openidconnect::PrivateSigningKey;
use openidconnect::core::{CoreEdDsaPrivateSigningKey, CoreHmacKey, CoreJsonWebKeySet, CoreJwsSigningAlgorithm};
use proxmox_crt::{App, Options, config, pve, totp};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use webauthn_authenticator_rs::WebauthnAuthenticator;
use webauthn_authenticator_rs::softpasskey::SoftPasskey;
use webauthn_rs::prelude::Url;

const PASSWORD: &str = "correct horse";

struct Bridge {
    addr: String,
    app: Arc<App>,
    config: PathBuf,
    http: reqwest::Client,
    /// The address the tests' browser has the page open at, if it is to
    /// say so as a browser does: `http://host:port`.
    page: Option<String>,
}

async fn bridge(name: &str) -> Bridge {
    bridge_with(name, None).await
}

/// A bridge that starts with `settings` in its settings file. `PORT` in
/// them stands for the port the bridge will be listening on.
async fn bridge_with(name: &str, settings: Option<&str>) -> Bridge {
    let dir = std::env::temp_dir().join(format!("proxmox-crt-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("client")).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    if let Some(settings) = settings {
        let port = listener.local_addr().unwrap().port().to_string();
        std::fs::write(dir.join("config.toml"), settings.replace("PORT", &port)).unwrap();
    }
    std::fs::write(dir.join("client/index.html"), "<title>proxmox-crt</title>").unwrap();
    let options = Options {
        config: dir.join("config.toml"),
        client: dir.join("client"),
    };
    let app = App::new(&options).unwrap();
    tokio::spawn(proxmox_crt::serve(app.clone(), options.client.clone(), listener));
    // The tests' own client speaks plain http, but is built with TLS in it.
    let _ = rustls::crypto::ring::default_provider().install_default();
    Bridge {
        addr,
        app,
        config: options.config,
        http: reqwest::Client::new(),
        page: None,
    }
}

impl Bridge {
    async fn post(&self, path: &str, body: Value, cookie: Option<&str>) -> (u16, Value, Option<String>) {
        self.send(reqwest::Method::POST, path, body, cookie).await
    }

    async fn delete(&self, path: &str, body: Value, cookie: Option<&str>) -> (u16, Value) {
        let (status, body, _) = self.send(reqwest::Method::DELETE, path, body, cookie).await;
        (status, body)
    }

    /// Answers the status, the body and the first cookie that was set.
    async fn send(&self, method: reqwest::Method, path: &str, body: Value, cookie: Option<&str>) -> (u16, Value, Option<String>) {
        let mut request = self.http.request(method, format!("http://{}{path}", self.addr)).json(&body);
        if let Some(page) = &self.page {
            request = request.header("Origin", page).header("Host", page.split_once("://").unwrap().1);
        }
        if let Some(cookie) = cookie {
            request = request.header("Cookie", cookie);
        }
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        let cookie = response
            .headers()
            .get("set-cookie")
            .map(|v| v.to_str().unwrap().split(';').next().unwrap().to_string());
        (status, response.json().await.unwrap_or(Value::Null), cookie)
    }

    async fn state(&self, cookie: Option<&str>) -> Value {
        self.get("/api/state", cookie).await.1
    }

    async fn get(&self, path: &str, cookie: Option<&str>) -> (u16, Value) {
        let mut request = self.http.get(format!("http://{}{path}", self.addr));
        if let Some(cookie) = cookie {
            request = request.header("Cookie", cookie);
        }
        let response = request.send().await.unwrap();
        (response.status().as_u16(), response.json().await.unwrap_or(Value::Null))
    }

    /// Sets up an authenticator app for the session and returns its key
    /// and the recovery codes. The code that confirms it is used up by
    /// that, so it is the one of the half minute before: this half
    /// minute's is then still good for logging in.
    async fn enrol(&self, cookie: &str) -> (Vec<u8>, Vec<String>) {
        let (status, start, _) = self
            .post("/api/second-factor/totp/start", json!({ "password": PASSWORD }), Some(cookie))
            .await;
        assert_eq!(status, 200, "{start}");
        let key = totp::decode_secret(start["secret"].as_str().unwrap()).unwrap();
        let code = totp::code(&key, totp::step_now() - 1);
        let (status, done, _) = self
            .post("/api/second-factor/totp/confirm", json!({ "code": code }), Some(cookie))
            .await;
        assert_eq!(status, 200, "{done}");
        let recovery = done["recovery"].as_array().unwrap();
        (key, recovery.iter().map(|code| code.as_str().unwrap().to_string()).collect())
    }

    /// Gives the password and returns the cookie of the second step.
    async fn password_step(&self) -> String {
        self.password_step_to(json!({ "totp": true, "passkey": false })).await
    }

    /// The same, where the second step is to offer `factors`.
    async fn password_step_to(&self, factors: Value) -> String {
        let (status, body, cookie) = self.post("/api/login", json!({ "password": PASSWORD }), None).await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["second_factor"], factors);
        let cookie = cookie.unwrap();
        assert!(cookie.starts_with("crt_pending="), "{cookie}");
        cookie
    }

    /// Adds a passkey held by `authenticator` and returns the bridge's id
    /// for it.
    async fn add_passkey(&self, authenticator: &mut SoftPasskey, name: &str, cookie: &str) -> String {
        let form = json!({ "password": PASSWORD, "name": name });
        let (status, start, _) = self.post("/api/second-factor/passkey/start", form, Some(cookie)).await;
        assert_eq!(status, 200, "{start}");
        let options = serde_json::from_value(start["options"].clone()).unwrap();
        let made = authenticator.do_registration(self.page_url(), options).unwrap();
        let (status, done, _) = self
            .post("/api/second-factor/passkey/finish", json!({ "credential": made }), Some(cookie))
            .await;
        assert_eq!(status, 200, "{done}");
        done["passkey"]["id"].as_str().unwrap().to_string()
    }

    /// Asks for a passkey at the second step and has `authenticator` sign
    /// the challenge. Returns the signed answer, not sent yet.
    async fn sign_passkey(&self, authenticator: &mut SoftPasskey, pending: &str) -> Value {
        let (status, start, _) = self.post("/api/login/passkey/start", json!({}), Some(pending)).await;
        assert_eq!(status, 200, "{start}");
        let options = serde_json::from_value(start["options"].clone()).unwrap();
        let signed = authenticator.do_authentication(self.page_url(), options).unwrap();
        json!({ "credential": signed })
    }

    fn page_url(&self) -> Url {
        Url::parse(self.page.as_deref().unwrap()).unwrap()
    }

    fn setup_form(&self, mock: &mock_pve::Running) -> Value {
        json!({
            "code": self.app.setup_code(),
            "url": mock.addr.to_string(),
            "token_id": mock_pve::TOKEN_ID,
            "token_secret": mock_pve::TOKEN_SECRET,
            "password": PASSWORD,
        })
    }

    /// Sets the bridge up against the mock and returns the session cookie.
    async fn set_up(&self, mock: &mock_pve::Running) -> String {
        let mut form = self.setup_form(mock);
        form["fingerprint"] = json!(mock.fingerprint);
        let (status, body, cookie) = self.post("/api/setup", form, None).await;
        assert_eq!(status, 200, "{body}");
        cookie.unwrap()
    }

    async fn socket(
        &self,
        path: &str,
        cookie: Option<&str>,
    ) -> Result<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, u16> {
        let mut request = format!("ws://{}{path}", self.addr).into_client_request().unwrap();
        if let Some(cookie) = cookie {
            request.headers_mut().insert("Cookie", cookie.parse().unwrap());
        }
        match tokio_tungstenite::connect_async(request).await {
            Ok((stream, _)) => Ok(stream),
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => Err(response.status().as_u16()),
            Err(e) => panic!("{e}"),
        }
    }
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn next(socket: &mut Socket) -> Message {
    tokio::time::timeout(Duration::from_secs(10), socket.next())
        .await
        .expect("an answer in time")
        .expect("the socket still open")
        .unwrap()
}

/// Reads what the console prints until it has printed `want`.
async fn until(socket: &mut Socket, want: &str) -> String {
    let mut printed = String::new();
    while !printed.contains(want) {
        match next(socket).await {
            Message::Binary(b) => printed.push_str(&String::from_utf8_lossy(&b)),
            Message::Text(t) => panic!("a note in place of output: {t} (after {printed:?})"),
            other => panic!("{other:?} (after {printed:?})"),
        }
    }
    printed
}

#[tokio::test]
async fn the_setup_card_pins_the_certificate_and_saves_the_token() {
    let mock = mock_pve::start("127.0.0.1:0").await;
    let bridge = bridge("setup").await;
    assert_eq!(bridge.state(None).await["configured"], false);

    // Without the code from the log, nothing.
    let mut wrong = bridge.setup_form(&mock);
    wrong["code"] = json!("AAAA-AAAA");
    assert_eq!(bridge.post("/api/setup", wrong, None).await.0, 403);

    // The first answer is the fingerprint to compare, and nothing is saved.
    let (status, body, cookie) = bridge.post("/api/setup", bridge.setup_form(&mock), None).await;
    assert_eq!(status, 200);
    assert_eq!(body["confirm_fingerprint"], mock.fingerprint);
    assert!(cookie.is_none());
    assert!(!bridge.config.exists());

    // A token Proxmox refuses is reported, and still nothing is saved.
    let mut refused = bridge.setup_form(&mock);
    refused["fingerprint"] = json!(mock.fingerprint);
    refused["token_secret"] = json!("not-the-secret");
    let (status, body, _) = bridge.post("/api/setup", refused, None).await;
    assert_eq!(status, 502);
    assert!(body["error"].as_str().unwrap().contains("refused the API token"), "{body}");
    assert!(!bridge.config.exists());

    // A fingerprint that is not the host's is refused too.
    let mut other = bridge.setup_form(&mock);
    other["fingerprint"] = json!(pve::fingerprint(b"some other certificate"));
    let (status, body, _) = bridge.post("/api/setup", other, None).await;
    assert_eq!(status, 502);
    assert!(body["error"].as_str().unwrap().contains("certificate changed"), "{body}");

    let cookie = bridge.set_up(&mock).await;
    let state = bridge.state(Some(&cookie)).await;
    assert_eq!(state["configured"], true);
    assert_eq!(state["authed"], true);
    assert_eq!(bridge.state(None).await["authed"], false);

    let saved = config::Config::load(&bridge.config).unwrap();
    let proxmox = saved.proxmox.unwrap();
    assert_eq!(proxmox.url, format!("https://{}", mock.addr));
    assert_eq!(proxmox.fingerprint.as_deref(), Some(mock.fingerprint.as_str()));
    assert!(auth_hash_matches(&saved.password_hash.unwrap()));

    // Once set up, the card is closed.
    assert_eq!(bridge.post("/api/setup", bridge.setup_form(&mock), None).await.0, 409);
}

fn auth_hash_matches(hash: &str) -> bool {
    proxmox_crt::auth::verify_password(PASSWORD, hash)
}

#[tokio::test]
async fn logging_in_takes_the_password_and_only_from_this_page() {
    let mock = mock_pve::start("127.0.0.1:0").await;
    let bridge = bridge("login").await;
    let cookie = bridge.set_up(&mock).await;

    let (status, _, _) = bridge.post("/api/logout", json!({}), Some(&cookie)).await;
    assert_eq!(status, 200);
    assert_eq!(bridge.state(Some(&cookie)).await["authed"], false);

    assert_eq!(bridge.post("/api/login", json!({ "password": "wrong horse" }), None).await.0, 403);
    let (status, _, cookie) = bridge.post("/api/login", json!({ "password": PASSWORD }), None).await;
    assert_eq!(status, 200);
    assert_eq!(bridge.state(cookie.as_deref()).await["authed"], true);

    // Another site's page cannot log in through this browser.
    let response = bridge
        .http
        .post(format!("http://{}/api/login", bridge.addr))
        .header("Origin", "http://elsewhere.example")
        .json(&json!({ "password": PASSWORD }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 403);

    // Guesses run out.
    for _ in 0..6 {
        bridge.post("/api/login", json!({ "password": "wrong horse" }), None).await;
    }
    assert_eq!(bridge.post("/api/login", json!({ "password": PASSWORD }), None).await.0, 429);
}

#[tokio::test]
async fn an_authenticator_app_is_set_up_with_the_password_and_a_code() {
    let mock = mock_pve::start("127.0.0.1:0").await;
    let bridge = bridge("enrol").await;
    let cookie = bridge.set_up(&mock).await;
    let start = "/api/second-factor/totp/start";

    let (status, enrolled) = bridge.get("/api/second-factor", Some(&cookie)).await;
    assert_eq!(status, 200);
    assert_eq!(enrolled["totp"], false);
    assert_eq!(enrolled["recovery"], 0);
    assert_eq!(enrolled["passkeys_possible"], false);
    assert_eq!(bridge.get("/api/second-factor", None).await.0, 401);

    // Not without a session, not without the password, not from another site.
    assert_eq!(bridge.post(start, json!({ "password": PASSWORD }), None).await.0, 401);
    assert_eq!(bridge.post(start, json!({ "password": "wrong horse" }), Some(&cookie)).await.0, 403);
    let elsewhere = bridge
        .http
        .post(format!("http://{}{start}", bridge.addr))
        .header("Origin", "http://elsewhere.example")
        .header("Cookie", &cookie)
        .json(&json!({ "password": PASSWORD }))
        .send()
        .await
        .unwrap();
    assert_eq!(elsewhere.status().as_u16(), 403);
    // A code with no secret handed out confirms nothing.
    assert_eq!(
        bridge
            .post("/api/second-factor/totp/confirm", json!({ "code": "123456" }), Some(&cookie))
            .await
            .0,
        409
    );

    let (status, started, _) = bridge.post(start, json!({ "password": PASSWORD }), Some(&cookie)).await;
    assert_eq!(status, 200, "{started}");
    let secret = started["secret"].as_str().unwrap();
    let key = totp::decode_secret(secret).unwrap();
    let uri = started["uri"].as_str().unwrap();
    assert!(uri.starts_with("otpauth://totp/proxmox-crt:127.0.0.1%3A"), "{uri}");
    assert!(uri.contains(&format!("secret={secret}&issuer=proxmox-crt&algorithm=SHA1&digits=6&period=30")));
    assert!(started["qr"].as_str().unwrap().starts_with("<svg "));

    // A wrong code saves nothing, and the password alone still logs in.
    let now = totp::step_now();
    let wrong = totp::code(&key, now + 1000);
    let (status, body, _) = bridge
        .post("/api/second-factor/totp/confirm", json!({ "code": wrong }), Some(&cookie))
        .await;
    assert_eq!(status, 403, "{body}");
    assert!(config::Config::load(&bridge.config).unwrap().second_factor.is_empty());
    assert_eq!(bridge.get("/api/second-factor", Some(&cookie)).await.1["totp"], false);

    let (status, done, _) = bridge
        .post(
            "/api/second-factor/totp/confirm",
            json!({ "code": totp::code(&key, now) }),
            Some(&cookie),
        )
        .await;
    assert_eq!(status, 200, "{done}");
    let recovery = done["recovery"].as_array().unwrap();
    assert_eq!(recovery.len(), 10);
    let enrolled = bridge.get("/api/second-factor", Some(&cookie)).await.1;
    assert_eq!(enrolled["totp"], true);
    assert_eq!(enrolled["recovery"], 10);
    assert!(enrolled.to_string().find(secret).is_none());

    // The file keeps the secret, and of the recovery codes only hashes.
    let text = std::fs::read_to_string(&bridge.config).unwrap();
    let saved = config::Config::load(&bridge.config).unwrap().second_factor;
    assert_eq!(saved.totp_secret.as_deref(), Some(secret));
    assert_eq!(saved.recovery.len(), 10);
    for code in recovery {
        let code = code.as_str().unwrap();
        assert!(!text.contains(code));
        assert!(saved.recovery.contains(&totp::recovery_hash(code)));
    }

    // One app at a time.
    assert_eq!(bridge.post(start, json!({ "password": PASSWORD }), Some(&cookie)).await.0, 409);

    // The code that confirmed the app was used up by that: whoever saw it
    // typed cannot log in with it, and the next one can.
    assert_eq!(saved.totp_last_step, Some(now));
    let pending = bridge.password_step().await;
    let again = json!({ "code": totp::code(&key, now) });
    let (status, body, _) = bridge.post("/api/login/totp", again, Some(&pending)).await;
    assert_eq!(status, 403, "{body}");
    let next = json!({ "code": totp::code(&key, now + 1) });
    let (status, body, _) = bridge.post("/api/login/totp", next, Some(&pending)).await;
    assert_eq!(status, 200, "{body}");
}

#[tokio::test]
async fn with_a_second_factor_the_password_alone_opens_nothing() {
    let mock = mock_pve::start("127.0.0.1:0").await;
    let bridge = bridge("second-step").await;
    let cookie = bridge.set_up(&mock).await;
    let (key, recovery) = bridge.enrol(&cookie).await;
    bridge.post("/api/logout", json!({}), Some(&cookie)).await;
    let totp_step = "/api/login/totp";

    // The password earns the second step and nothing else.
    let pending = bridge.password_step().await;
    assert_eq!(bridge.state(Some(&pending)).await["authed"], false);
    assert_eq!(bridge.socket("/api/feed", Some(&pending)).await.err(), Some(401));
    assert_eq!(bridge.get("/api/second-factor", Some(&pending)).await.0, 401);
    let as_session = pending.replace("crt_pending=", "crt_session=");
    assert_eq!(bridge.socket("/api/feed", Some(&as_session)).await.err(), Some(401));
    assert_eq!(bridge.state(Some(&as_session)).await["authed"], false);

    // The second step is for whoever gave the password, and for this page.
    let now = totp::step_now();
    let code = totp::code(&key, now);
    assert_eq!(bridge.post(totp_step, json!({ "code": code }), None).await.0, 401);
    let elsewhere = bridge
        .http
        .post(format!("http://{}{totp_step}", bridge.addr))
        .header("Origin", "http://elsewhere.example")
        .header("Cookie", &pending)
        .json(&json!({ "code": code }))
        .send()
        .await
        .unwrap();
    assert_eq!(elsewhere.status().as_u16(), 403);

    // A wrong code is refused and the right one opens the session.
    let (status, body, _) = bridge
        .post(totp_step, json!({ "code": totp::code(&key, now + 1000) }), Some(&pending))
        .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(bridge.socket("/api/feed", Some(&pending)).await.err(), Some(401));
    let (status, body, session) = bridge.post(totp_step, json!({ "code": code }), Some(&pending)).await;
    assert_eq!(status, 200, "{body}");
    let session = session.unwrap();
    assert!(session.starts_with("crt_session="), "{session}");
    assert_eq!(bridge.state(Some(&session)).await["authed"], true);
    assert!(bridge.socket("/api/feed", Some(&session)).await.is_ok());
    // The second step's cookie has done its work.
    assert_eq!(
        bridge
            .post(totp_step, json!({ "code": totp::code(&key, now + 1) }), Some(&pending))
            .await
            .0,
        401
    );

    // The same code a second time is refused; the next one is taken.
    let pending = bridge.password_step().await;
    let (status, body, cookie) = bridge.post(totp_step, json!({ "code": code }), Some(&pending)).await;
    assert_eq!(status, 403, "{body}");
    assert!(cookie.is_none());
    let (status, body, _) = bridge
        .post(totp_step, json!({ "code": totp::code(&key, now + 1) }), Some(&pending))
        .await;
    assert_eq!(status, 200, "{body}");

    // A recovery code works in place of the app, once.
    let pending = bridge.password_step().await;
    let typed = recovery[3].to_ascii_lowercase().replace('-', " ");
    let (status, body, session) = bridge.post(totp_step, json!({ "code": typed }), Some(&pending)).await;
    assert_eq!(status, 200, "{body}");
    let session = session.unwrap();
    assert_eq!(bridge.get("/api/second-factor", Some(&session)).await.1["recovery"], 9);
    assert_eq!(config::Config::load(&bridge.config).unwrap().second_factor.recovery.len(), 9);
    let pending = bridge.password_step().await;
    let (status, body, _) = bridge.post(totp_step, json!({ "code": recovery[3] }), Some(&pending)).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(bridge.state(Some(&pending)).await["authed"], false);
}

#[tokio::test]
async fn wrong_codes_run_out_as_wrong_passwords_do() {
    let mock = mock_pve::start("127.0.0.1:0").await;
    let bridge = bridge("code-guesses").await;
    let cookie = bridge.set_up(&mock).await;
    let (key, recovery) = bridge.enrol(&cookie).await;

    let before = config::Config::load(&bridge.config).unwrap().second_factor;
    let wrong = totp::code(&key, totp::step_now() + 1000);
    let code_step = "/api/login/totp";
    // One right password is good for three answers: the third wrong one
    // says to give it again, and has closed the second step.
    let pending = bridge.password_step().await;
    for _ in 0..2 {
        let (status, body, _) = bridge.post(code_step, json!({ "code": wrong }), Some(&pending)).await;
        assert_eq!((status, body["error"].as_str()), (403, Some("Wrong code.")));
    }
    let (status, body, _) = bridge.post(code_step, json!({ "code": wrong }), Some(&pending)).await;
    assert_eq!(status, 401, "{body}");
    assert_eq!(body["error"], "Too many wrong codes. Enter the password again.");
    let right = totp::code(&key, totp::step_now());
    let (status, body, cookie) = bridge.post(code_step, json!({ "code": right }), Some(&pending)).await;
    assert_eq!(status, 401, "{body}");
    assert!(cookie.is_none());
    // The right password is not a guess, so it can be given again, and
    // the wrong codes after it count on.
    let pending = bridge.password_step().await;
    for _ in 0..2 {
        let (status, _, _) = bridge.post(code_step, json!({ "code": wrong }), Some(&pending)).await;
        assert_eq!(status, 403);
    }
    // Now not even the right code is looked at, nor a recovery code, nor
    // the password.
    let right = totp::code(&key, totp::step_now());
    assert_eq!(bridge.post(code_step, json!({ "code": right }), Some(&pending)).await.0, 429);
    assert_eq!(bridge.post(code_step, json!({ "code": recovery[0] }), Some(&pending)).await.0, 429);
    assert_eq!(bridge.post("/api/login", json!({ "password": PASSWORD }), None).await.0, 429);
    assert_eq!(config::Config::load(&bridge.config).unwrap().second_factor, before);
    assert_eq!(before.recovery.len(), 10);
}

/// Tries `password` as a visitor would whose request a proxy passed on with
/// `forwarded` as its `X-Forwarded-For` header, and answers the status.
async fn log_in_through_a_proxy(bridge: &Bridge, forwarded: &str, password: &str) -> u16 {
    let response = bridge
        .http
        .post(format!("http://{}/api/login", bridge.addr))
        .header("X-Forwarded-For", forwarded)
        .json(&json!({ "password": password }))
        .send()
        .await
        .unwrap();
    response.status().as_u16()
}

#[tokio::test]
async fn behind_a_trusted_proxy_wrong_passwords_count_against_the_visitor() {
    let mock = mock_pve::start("127.0.0.1:0").await;
    // The tests' requests come from this machine, which here is the proxy.
    let bridge = bridge_with("proxy-trusted", Some("trusted_proxies = [\"127.0.0.1\"]\n")).await;
    let cookie = bridge.set_up(&mock).await;
    // The setup card wrote the file and left the proxies in it.
    assert_eq!(config::Config::load(&bridge.config).unwrap().trusted_proxies, ["127.0.0.1"]);
    bridge.post("/api/logout", json!({}), Some(&cookie)).await;

    for _ in 0..5 {
        assert_eq!(log_in_through_a_proxy(&bridge, "203.0.113.7", "wrong horse").await, 403);
    }
    // That visitor has to wait, whatever it writes into the header itself:
    // the proxy adds the address it saw at the right.
    assert_eq!(log_in_through_a_proxy(&bridge, "203.0.113.7", PASSWORD).await, 429);
    assert_eq!(log_in_through_a_proxy(&bridge, "198.51.100.1, 203.0.113.7", PASSWORD).await, 429);
    assert_eq!(log_in_through_a_proxy(&bridge, "127.0.0.1, 203.0.113.7", PASSWORD).await, 429);
    // Another visitor behind the same proxy does not, and neither does the
    // proxy's own address, which a header with nothing to go by counts under.
    assert_eq!(log_in_through_a_proxy(&bridge, "203.0.113.8", "wrong horse").await, 403);
    assert_eq!(log_in_through_a_proxy(&bridge, "203.0.113.8", PASSWORD).await, 200);
    assert_eq!(log_in_through_a_proxy(&bridge, "203.0.113.7, unknown", PASSWORD).await, 200);
    assert_eq!(bridge.post("/api/login", json!({ "password": PASSWORD }), None).await.0, 200);
}

#[tokio::test]
async fn without_a_trusted_proxy_the_forwarded_header_changes_nothing() {
    let mock = mock_pve::start("127.0.0.1:0").await;
    // A proxy is named, but it is not where the requests come from.
    for (name, settings) in [
        ("proxy-none", None),
        ("proxy-elsewhere", Some("trusted_proxies = [\"192.168.1.5\", \"10.0.0.0/24\"]\n")),
    ] {
        let bridge = bridge_with(name, settings).await;
        let cookie = bridge.set_up(&mock).await;
        bridge.post("/api/logout", json!({}), Some(&cookie)).await;
        // Each try names another address, and all count as the one they
        // really come from.
        for last in 1..=5 {
            let forwarded = format!("203.0.113.{last}");
            assert_eq!(log_in_through_a_proxy(&bridge, &forwarded, "wrong horse").await, 403);
        }
        assert_eq!(log_in_through_a_proxy(&bridge, "203.0.113.99", PASSWORD).await, 429, "{name}");
        assert_eq!(
            bridge.post("/api/login", json!({ "password": PASSWORD }), None).await.0,
            429,
            "{name}"
        );
    }
}

#[tokio::test]
async fn a_proxy_that_is_no_address_stops_the_bridge_from_starting() {
    let dir = std::env::temp_dir().join(format!("proxmox-crt-test-{}-proxy-misspelt", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("config.toml");
    for (settings, entry) in [
        ("trusted_proxies = [\"192.168.1.5\", \"10.0.0.0/33\"]\n", "\"10.0.0.0/33\""),
        ("trusted_proxies = [\"myproxy\"]\n", "\"myproxy\""),
    ] {
        std::fs::write(&path, settings).unwrap();
        let options = Options {
            config: path.clone(),
            client: PathBuf::new(),
        };
        let refused = App::new(&options).err().expect("the bridge does not start").to_string();
        assert!(refused.contains("trusted_proxies") && refused.contains(entry), "{refused}");
    }
    // The bridge itself says so and stops.
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_proxmox-crt"))
        .arg("--config")
        .arg(&path)
        .arg("--listen")
        .arg("127.0.0.1:0")
        .output()
        .unwrap();
    assert!(!output.status.success());
    let said = String::from_utf8_lossy(&output.stderr);
    assert!(said.contains("trusted_proxies: \"myproxy\" is not an address"), "{said}");
}

/// A browser on this machine that comes from another of its addresses.
#[cfg(target_os = "linux")]
fn from_address(last: u8) -> reqwest::Client {
    let address = std::net::IpAddr::from([127, 0, 0, last]);
    reqwest::Client::builder().local_address(address).build().unwrap()
}

// Only Linux answers on every address that begins with 127.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn wrong_codes_from_many_addresses_make_the_whole_wall_wait() {
    let mock = mock_pve::start("127.0.0.1:0").await;
    let mut bridge = bridge("code-guesses-everywhere").await;
    let cookie = bridge.set_up(&mock).await;
    let (key, recovery) = bridge.enrol(&cookie).await;
    let wrong = totp::code(&key, totp::step_now() + 1000);
    let code_step = "/api/login/totp";

    // Someone who has the password guesses from one address after
    // another, four times from each, which no address is kept out for.
    // Eleven wrong codes are looked at, wherever they come from.
    let mut looked_at = 0;
    'guessing: for address in 2..=5 {
        bridge.http = from_address(address);
        for _ in 0..2 {
            let pending = bridge.password_step().await;
            for _ in 0..2 {
                let (status, body, _) = bridge.post(code_step, json!({ "code": wrong }), Some(&pending)).await;
                if status == 429 {
                    assert_eq!(body["error"], "Too many wrong codes. Try again in a minute.");
                    break 'guessing;
                }
                assert_eq!(status, 403, "{body}");
                looked_at += 1;
            }
        }
    }
    assert_eq!(looked_at, 11);
    // Now nobody's code is looked at, from an address that never guessed
    // either: not the right one, not a recovery code.
    bridge.http = from_address(9);
    let pending = bridge.password_step().await;
    let right = totp::code(&key, totp::step_now());
    for code in [&right, &recovery[0]] {
        let (status, body, cookie) = bridge.post(code_step, json!({ "code": code }), Some(&pending)).await;
        assert_eq!(status, 429, "{body}");
        assert!(cookie.is_none());
    }
    // Being told to wait used up neither the address's guesses nor the
    // password's answers, and the session that is open stays open.
    for _ in 0..6 {
        assert_eq!(bridge.post(code_step, json!({ "code": right }), Some(&pending)).await.0, 429);
    }
    assert_eq!(bridge.password_step().await.len(), "crt_pending=".len() + 64);
    assert_eq!(bridge.state(Some(&cookie)).await["authed"], true);
    assert_eq!(config::Config::load(&bridge.config).unwrap().second_factor.recovery.len(), 10);
}

#[tokio::test]
async fn setting_up_the_first_second_factor_closes_the_sessions_the_password_opened() {
    let mock = mock_pve::start("127.0.0.1:0").await;
    let bridge = bridge("old-sessions").await;
    let cookie = bridge.set_up(&mock).await;
    // Someone else has the password, and logged in with it before the
    // owner set up the app: a session, and a feed open on it.
    let (status, _, other) = bridge.post("/api/login", json!({ "password": PASSWORD }), None).await;
    assert_eq!(status, 200);
    let other = other.unwrap();
    assert!(other.starts_with("crt_session="), "{other}");
    let mut feed = bridge.socket("/api/feed", Some(&other)).await.unwrap();
    let mut mine = bridge.socket("/api/feed", Some(&cookie)).await.unwrap();
    assert!(matches!(next(&mut feed).await, Message::Text(_)));
    assert!(matches!(next(&mut mine).await, Message::Text(_)));

    bridge.enrol(&cookie).await;

    // The session that set it up goes on. The other is closed, its feed
    // with it, and the password alone no longer takes the app off again.
    assert_eq!(bridge.state(Some(&cookie)).await["authed"], true);
    assert_eq!(bridge.state(Some(&other)).await["authed"], false);
    let closed = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match feed.next().await {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            }
        }
    });
    closed.await.expect("the other session's feed to close");
    assert!(matches!(next(&mut mine).await, Message::Text(_)));
    assert_eq!(bridge.socket("/api/feed", Some(&other)).await.err(), Some(401));
    let (status, _) = bridge
        .delete("/api/second-factor/totp", json!({ "password": PASSWORD }), Some(&other))
        .await;
    assert_eq!(status, 401);
    assert!(config::Config::load(&bridge.config).unwrap().second_factor.enrolled());

    // A session opened with the second step is not closed by a further
    // factor's coming.
    let pending = bridge.password_step().await;
    let recovery = bridge
        .post("/api/second-factor/recovery", json!({ "password": PASSWORD }), Some(&cookie))
        .await
        .1;
    let (status, _, second) = bridge
        .post("/api/login/totp", json!({ "code": recovery["recovery"][0] }), Some(&pending))
        .await;
    assert_eq!(status, 200);
    assert_eq!(bridge.state(second.as_deref()).await["authed"], true);
    assert_eq!(bridge.state(Some(&cookie)).await["authed"], true);
}

/// Runs the bridge's own program on a settings file with one of its flags.
fn run_flag(flag: &str, config: &std::path::Path) -> std::process::Output {
    std::process::Command::new(env!("CARGO_BIN_EXE_proxmox-crt"))
        .arg(flag)
        .arg("--config")
        .arg(config)
        .output()
        .unwrap()
}

#[tokio::test]
async fn what_is_put_in_the_file_while_the_bridge_runs_is_not_written_over() {
    let mock = mock_pve::start("127.0.0.1:0").await;
    let bridge = bridge("file-edits").await;
    let cookie = bridge.set_up(&mock).await;
    let (key, recovery) = bridge.enrol(&cookie).await;
    let code_step = "/api/login/totp";

    // The owner writes single sign-on into the file by hand, as the
    // README says to, and has not restarted the bridge yet.
    let by_hand = "public_url = \"https://crt.example.com\"\n";
    let sso =
        "\n[oidc]\nissuer = \"https://accounts.example.com\"\nclient_id = \"wall\"\nallow = [\"me@example.com\"]\npassword_login = false\n";
    let text = std::fs::read_to_string(&bridge.config).unwrap();
    std::fs::write(&bridge.config, format!("{by_hand}{text}{sso}")).unwrap();
    let written = config::Config::load(&bridge.config).unwrap();

    // A log-in with a code has the bridge write the file: the newest
    // code's step goes in, and what was written by hand stays.
    let pending = bridge.password_step().await;
    let now = totp::step_now();
    let code = json!({ "code": totp::code(&key, now) });
    assert_eq!(bridge.post(code_step, code, Some(&pending)).await.0, 200);
    let mut expected = written.clone();
    expected.second_factor.totp_last_step = Some(now);
    assert_eq!(config::Config::load(&bridge.config).unwrap(), expected);
    // The bridge itself goes on as it was started, until it is restarted.
    let state = bridge.state(None).await;
    assert_eq!((&state["oidc"], &state["password_login"]), (&Value::Null, &json!(true)));

    // The password is turned back on from the machine while the bridge
    // runs. What the bridge writes after that does not turn it off again.
    let output = run_flag("--enable-password-login", &bridge.config);
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let (status, body, _) = bridge
        .post("/api/second-factor/recovery", json!({ "password": PASSWORD }), Some(&cookie))
        .await;
    assert_eq!(status, 200, "{body}");
    let saved = config::Config::load(&bridge.config).unwrap();
    assert!(saved.password_login());
    assert_eq!(saved.public_url, written.public_url);
    assert!(
        recovery
            .iter()
            .all(|old| !saved.second_factor.recovery.contains(&totp::recovery_hash(old)))
    );

    // The second factors are taken off from the machine while the bridge
    // runs, and someone is at the second step meanwhile. Their code is
    // refused and brings nothing back into the file.
    let pending = bridge.password_step().await;
    let output = run_flag("--reset-second-factor", &bridge.config);
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let code = json!({ "code": totp::code(&key, now + 1) });
    let (status, body, _) = bridge.post(code_step, code, Some(&pending)).await;
    assert_eq!(status, 403, "{body}");
    let saved = config::Config::load(&bridge.config).unwrap();
    assert!(saved.second_factor.is_empty());
    assert!(saved.password_login());
    assert!(!std::fs::read_to_string(&bridge.config).unwrap().contains("second_factor"));
    // From then on the password alone logs in, restart or none, and the
    // settings card shows nothing set up.
    let (status, body, session) = bridge.post("/api/login", json!({ "password": PASSWORD }), None).await;
    assert_eq!(status, 200, "{body}");
    assert!(body.get("second_factor").is_none());
    let session = session.unwrap();
    assert!(session.starts_with("crt_session="), "{session}");
    assert_eq!(bridge.get("/api/second-factor", Some(&session)).await.1["totp"], false);
    assert_eq!(config::Config::load(&bridge.config).unwrap(), saved);

    // A file that cannot be read is not written over either, and the
    // refusal does not quote it: the line at fault could be a secret.
    bridge.enrol(&session).await;
    let good = std::fs::read_to_string(&bridge.config).unwrap();
    std::fs::write(&bridge.config, "listen = [\n").unwrap();
    let (status, body, _) = bridge
        .post("/api/second-factor/recovery", json!({ "password": PASSWORD }), Some(&session))
        .await;
    assert_eq!(status, 500, "{body}");
    assert!(body["error"].as_str().unwrap().starts_with("Could not read "), "{body}");
    assert!(!body["error"].as_str().unwrap().contains("listen"), "{body}");
    assert_eq!(std::fs::read_to_string(&bridge.config).unwrap(), "listen = [\n");
    std::fs::write(&bridge.config, good).unwrap();
}

/// Whether the tests run as root, who alone can make a file someone
/// else's.
#[cfg(unix)]
fn is_root() -> bool {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata("/proc/self").is_ok_and(|m| m.uid() == 0)
}

// The bridge runs as a user of its own, and root edits its settings: a
// file that root wrote anew belongs to root, and the bridge cannot give
// its own next one back.
#[cfg(unix)]
#[tokio::test]
async fn a_file_that_root_replaced_can_still_be_written_by_the_bridge() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt, chown};
    use std::os::unix::process::CommandExt;
    const NOBODY: u32 = 65534;
    let program = env!("CARGO_BIN_EXE_proxmox-crt");
    let as_nobody = |arguments: &[&str]| {
        let mut command = std::process::Command::new(program);
        command.args(arguments).uid(NOBODY).gid(NOBODY).output()
    };
    // Only root can set this up, and only where the program can be run by
    // someone else.
    if !is_root() || !as_nobody(&["--version"]).is_ok_and(|output| output.status.success()) {
        eprintln!("skipped: needs root, and a program that another user can run");
        return;
    }
    let dir = std::env::temp_dir().join(format!("proxmox-crt-test-{}-root-file", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("config.toml");
    let mut config = config::Config::new();
    config.second_factor.totp_secret = Some("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ".into());
    config.save(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    chown(&dir, Some(NOBODY), Some(NOBODY)).unwrap();
    assert_eq!(std::fs::metadata(&path).unwrap().uid(), 0);

    let output = as_nobody(&["--reset-second-factor", "--config", path.to_str().unwrap()]).unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let after = std::fs::metadata(&path).unwrap();
    assert_eq!((after.uid(), after.mode() & 0o777), (NOBODY, 0o600));
    assert!(config::Config::load(&path).unwrap().second_factor.is_empty());
    assert!(!dir.join("config.toml.new").exists());

    // Where nothing can be written, nothing is left behind.
    config.save(&path).unwrap();
    chown(&dir, Some(0), Some(0)).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    let output = as_nobody(&["--reset-second-factor", "--config", path.to_str().unwrap()]).unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("could not reset"));
    assert!(config::Config::load(&path).unwrap().second_factor.enrolled());
    assert!(!dir.join("config.toml.new").exists());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn changing_the_second_factor_takes_the_password_again() {
    let mock = mock_pve::start("127.0.0.1:0").await;
    let bridge = bridge("factor-change").await;
    let cookie = bridge.set_up(&mock).await;

    // Recovery codes stand in for an app, so there are none without one.
    let fresh = "/api/second-factor/recovery";
    assert_eq!(bridge.post(fresh, json!({ "password": PASSWORD }), Some(&cookie)).await.0, 409);
    assert_eq!(
        bridge
            .delete("/api/second-factor/totp", json!({ "password": PASSWORD }), Some(&cookie))
            .await
            .0,
        409
    );

    let (_, recovery) = bridge.enrol(&cookie).await;

    // A fresh set replaces the old one.
    assert_eq!(bridge.post(fresh, json!({ "password": "wrong horse" }), Some(&cookie)).await.0, 403);
    assert_eq!(bridge.post(fresh, json!({ "password": PASSWORD }), None).await.0, 401);
    let (status, body, _) = bridge.post(fresh, json!({ "password": PASSWORD }), Some(&cookie)).await;
    assert_eq!(status, 200, "{body}");
    let renewed = body["recovery"].as_array().unwrap();
    assert_eq!(renewed.len(), 10);
    let saved = config::Config::load(&bridge.config).unwrap().second_factor;
    assert_eq!(saved.recovery.len(), 10);
    assert!(saved.recovery.contains(&totp::recovery_hash(renewed[0].as_str().unwrap())));
    assert!(recovery.iter().all(|old| !saved.recovery.contains(&totp::recovery_hash(old))));

    // Removing the app takes the password too, and its codes go with it.
    let remove = "/api/second-factor/totp";
    assert_eq!(
        bridge.delete(remove, json!({ "password": "wrong horse" }), Some(&cookie)).await.0,
        403
    );
    assert_eq!(bridge.delete(remove, json!({ "password": PASSWORD }), None).await.0, 401);
    assert!(config::Config::load(&bridge.config).unwrap().second_factor.enrolled());
    let (status, body) = bridge.delete(remove, json!({ "password": PASSWORD }), Some(&cookie)).await;
    assert_eq!(status, 200, "{body}");
    assert!(config::Config::load(&bridge.config).unwrap().second_factor.is_empty());
    assert_eq!(bridge.get("/api/second-factor", Some(&cookie)).await.1["totp"], false);

    // The password alone logs in again.
    let (status, body, session) = bridge.post("/api/login", json!({ "password": PASSWORD }), None).await;
    assert_eq!(status, 200, "{body}");
    assert!(body.get("second_factor").is_none());
    assert_eq!(bridge.state(session.as_deref()).await["authed"], true);
}

#[tokio::test]
async fn the_reset_flag_removes_the_second_factor_from_the_file() {
    let mock = mock_pve::start("127.0.0.1:0").await;
    let bridge = bridge("factor-reset").await;
    let cookie = bridge.set_up(&mock).await;
    bridge.enrol(&cookie).await;
    let before = config::Config::load(&bridge.config).unwrap();
    assert!(before.second_factor.enrolled());

    let run = |config: PathBuf| {
        std::process::Command::new(env!("CARGO_BIN_EXE_proxmox-crt"))
            .arg("--reset-second-factor")
            .arg("--config")
            .arg(config)
            .output()
            .unwrap()
    };
    let output = run(bridge.config.clone());
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert!(String::from_utf8_lossy(&output.stdout).contains("Removed the second factors"));

    // Only the second factor is gone, and the file is still private.
    let after = config::Config::load(&bridge.config).unwrap();
    assert!(after.second_factor.is_empty());
    assert_eq!(after.password_hash, before.password_hash);
    assert_eq!(after.proxmox, before.proxmox);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&bridge.config).unwrap().permissions().mode() & 0o777, 0o600);
    }

    // A bridge started on that file asks for the password alone.
    let app = App::new(&Options {
        config: bridge.config.clone(),
        client: bridge.config.with_file_name("client"),
    })
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(proxmox_crt::serve(app, bridge.config.with_file_name("client"), listener));
    let response = bridge
        .http
        .post(format!("http://{addr}/api/login"))
        .json(&json!({ "password": PASSWORD }))
        .send()
        .await
        .unwrap();
    assert!(response.headers()["set-cookie"].to_str().unwrap().starts_with("crt_session="));

    // With nothing to remove it says so, and it makes no file of its own.
    let output = run(bridge.config.clone());
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("no second factor"));
    let missing = bridge.config.with_file_name("missing.toml");
    assert!(!run(missing.clone()).status.success());
    assert!(!missing.exists());
}

#[tokio::test]
async fn behind_https_the_cookies_travel_over_nothing_else() {
    let mock = mock_pve::start("127.0.0.1:0").await;
    let bridge = bridge_with("secure", Some("public_url = \"https://crt.example.com\"\n")).await;
    // The page is told so before anyone logs in: opened over plain http
    // it could take a password and never keep the session.
    assert_eq!(bridge.state(None).await["https_only"], true);
    let cookie = bridge.set_up(&mock).await;
    assert_eq!(bridge.get("/api/second-factor", Some(&cookie)).await.1["passkeys_possible"], true);
    assert_eq!(
        config::Config::load(&bridge.config).unwrap().public_url.as_deref(),
        Some("https://crt.example.com")
    );

    let login = |body: Value, path: &'static str, cookie: Option<String>| {
        let mut request = bridge.http.post(format!("http://{}{path}", bridge.addr)).json(&body);
        if let Some(cookie) = cookie {
            request = request.header("Cookie", cookie);
        }
        async move {
            let response = request.send().await.unwrap();
            let cookies = response.headers().get_all("set-cookie");
            cookies.iter().map(|c| c.to_str().unwrap().to_string()).collect::<Vec<_>>()
        }
    };
    let set = login(json!({ "password": PASSWORD }), "/api/login", None).await;
    assert!(set[0].starts_with("crt_session="), "{set:?}");
    assert!(set.iter().all(|c| c.ends_with("; HttpOnly; SameSite=Strict; Secure")), "{set:?}");

    // The second step's cookie too, and it is cleared once the step is done.
    let (key, _) = bridge.enrol(&cookie).await;
    let set = login(json!({ "password": PASSWORD }), "/api/login", None).await;
    assert_eq!(set.len(), 1, "{set:?}");
    assert!(set[0].starts_with("crt_pending="), "{set:?}");
    assert!(set[0].ends_with("; Max-Age=300; HttpOnly; SameSite=Strict; Secure"), "{set:?}");
    let pending = set[0].split(';').next().unwrap().to_string();
    let code = totp::code(&key, totp::step_now());
    let set = login(json!({ "code": code }), "/api/login/totp", Some(pending)).await;
    assert!(set[0].starts_with("crt_session="), "{set:?}");
    assert!(set[1].starts_with("crt_pending=; Path=/; Max-Age=0;"), "{set:?}");
    assert!(set.iter().all(|c| c.ends_with("; Secure")), "{set:?}");
}

/// A bridge whose page is reached at `http://localhost:<its port>`, which
/// is where a browser allows passkeys without https, set up and logged in.
async fn bridge_on_localhost(name: &str, mock: &mock_pve::Running) -> (Bridge, String) {
    let mut bridge = bridge_with(name, Some("public_url = \"http://localhost:PORT\"\n")).await;
    bridge.page = Some(format!("http://localhost:{}", bridge.addr.rsplit_once(':').unwrap().1));
    let cookie = bridge.set_up(mock).await;
    (bridge, cookie)
}

/// What the settings file has of its passkeys' counts of uses.
fn passkey_counts(bridge: &Bridge) -> Vec<u64> {
    let saved = config::Config::load(&bridge.config).unwrap();
    let passkeys = saved.second_factor.passkeys.iter();
    passkeys
        .map(|p| {
            serde_json::from_str::<Value>(&p.credential).unwrap()["cred"]["counter"]
                .as_u64()
                .unwrap()
        })
        .collect()
}

#[tokio::test]
async fn a_passkey_is_added_and_then_asked_for_after_the_password() {
    let mock = mock_pve::start("127.0.0.1:0").await;
    let (bridge, cookie) = bridge_on_localhost("passkey", &mock).await;
    let (_, enrolled) = bridge.get("/api/second-factor", Some(&cookie)).await;
    assert_eq!(enrolled["passkeys_possible"], true);
    assert_eq!(enrolled["passkeys"], json!([]));

    // What the browser is asked for: no attestation, a passkey the
    // authenticator may keep, and its owner checked where it can.
    let form = json!({ "password": PASSWORD, "name": "Phone" });
    let (status, start, _) = bridge.post("/api/second-factor/passkey/start", form, Some(&cookie)).await;
    assert_eq!(status, 200, "{start}");
    let asked = &start["options"]["publicKey"];
    assert_eq!(asked["rp"], json!({ "id": "localhost", "name": "proxmox-crt" }));
    assert_eq!(asked["attestation"], "none");
    assert_eq!(asked["authenticatorSelection"]["residentKey"], "preferred");
    assert_eq!(asked["authenticatorSelection"]["userVerification"], "preferred");
    assert_eq!(asked["timeout"], 300_000);
    assert!(asked.get("hints").is_none(), "{asked}");
    assert!(asked["extensions"].get("credentialProtectionPolicy").is_none(), "{asked}");
    assert!(asked["challenge"].as_str().unwrap().len() >= 43);

    // A challenge is answered by the session it was given to, and once.
    let mut phone = SoftPasskey::new(false);
    let options = serde_json::from_value(start["options"].clone()).unwrap();
    let made = json!({ "credential": phone.do_registration(bridge.page_url(), options).unwrap() });
    let other = bridge.post("/api/login", json!({ "password": PASSWORD }), None).await.2.unwrap();
    let (status, body, _) = bridge.post("/api/second-factor/passkey/finish", made.clone(), Some(&other)).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(bridge.post("/api/second-factor/passkey/finish", made.clone(), None).await.0, 401);
    let (status, body, _) = bridge.post("/api/second-factor/passkey/finish", made.clone(), Some(&cookie)).await;
    assert_eq!(status, 200, "{body}");
    let id = body["passkey"]["id"].as_str().unwrap().to_string();
    let (status, body, _) = bridge.post("/api/second-factor/passkey/finish", made, Some(&cookie)).await;
    assert_eq!(status, 409, "{body}");

    // It is listed and saved, without its key going back to the page.
    let (_, enrolled) = bridge.get("/api/second-factor", Some(&cookie)).await;
    assert_eq!(enrolled["passkeys"].as_array().unwrap().len(), 1, "{enrolled}");
    assert_eq!(enrolled["passkeys"][0]["id"], id.as_str());
    assert_eq!(enrolled["passkeys"][0]["name"], "Phone");
    assert!(enrolled["passkeys"][0]["added"].as_u64().unwrap() > 1_700_000_000);
    assert!(enrolled["passkeys"][0].get("credential").is_none());
    assert_eq!(enrolled["totp"], false);
    let saved = config::Config::load(&bridge.config).unwrap();
    assert_eq!(saved.second_factor.passkeys[0].id, id);
    assert_eq!(passkey_counts(&bridge), [0]);

    // The same authenticator is not added twice.
    let form = json!({ "password": PASSWORD, "name": "Phone again" });
    let (_, start, _) = bridge.post("/api/second-factor/passkey/start", form, Some(&cookie)).await;
    assert_eq!(
        start["options"]["publicKey"]["excludeCredentials"].as_array().unwrap().len(),
        1,
        "{start}"
    );

    // Now the password alone opens nothing, and the passkey is offered.
    let pending = bridge.password_step_to(json!({ "totp": false, "passkey": true })).await;
    assert_eq!(bridge.state(Some(&pending)).await["authed"], false);
    assert_eq!(bridge.get("/api/second-factor", Some(&pending)).await.0, 401);
    // A code is not the way in where no app is set up.
    assert_eq!(
        bridge.post("/api/login/totp", json!({ "code": "000000" }), Some(&pending)).await.0,
        403
    );
    // Nor is asking without the password, nor answering what was not asked.
    assert_eq!(bridge.post("/api/login/passkey/start", json!({}), None).await.0, 401);
    assert_eq!(bridge.post("/api/login/passkey/start", json!({}), Some(&cookie)).await.0, 401);

    let (status, start, _) = bridge.post("/api/login/passkey/start", json!({}), Some(&pending)).await;
    assert_eq!(status, 200, "{start}");
    let asked = &start["options"]["publicKey"];
    assert_eq!(asked["rpId"], "localhost");
    assert_eq!(asked["userVerification"], "preferred");
    assert_eq!(asked["allowCredentials"].as_array().unwrap().len(), 1, "{asked}");
    assert!(asked.get("hints").is_none(), "{asked}");
    let options = serde_json::from_value(start["options"].clone()).unwrap();
    let signed = json!({ "credential": phone.do_authentication(bridge.page_url(), options).unwrap() });
    assert_eq!(bridge.post("/api/login/passkey/finish", signed.clone(), None).await.0, 401);
    let (status, body, session) = bridge.post("/api/login/passkey/finish", signed.clone(), Some(&pending)).await;
    assert_eq!(status, 200, "{body}");
    let session = session.unwrap();
    assert!(session.starts_with("crt_session="), "{session}");
    assert_eq!(bridge.state(Some(&session)).await["authed"], true);
    // The count of uses the passkey gave is kept.
    assert_eq!(passkey_counts(&bridge), [1]);
    // The second step's cookie has done its work.
    assert_eq!(
        bridge.post("/api/login/passkey/finish", signed.clone(), Some(&pending)).await.0,
        401
    );

    // An answer to an earlier challenge is not an answer to this one, and
    // a wrong answer uses the challenge up.
    let pending = bridge.password_step_to(json!({ "totp": false, "passkey": true })).await;
    let fresh = bridge.sign_passkey(&mut phone, &pending).await;
    let (status, body, cookie_set) = bridge.post("/api/login/passkey/finish", signed, Some(&pending)).await;
    assert_eq!(status, 403, "{body}");
    assert!(cookie_set.is_none());
    let (status, body, _) = bridge.post("/api/login/passkey/finish", fresh, Some(&pending)).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(bridge.state(Some(&pending)).await["authed"], false);
    // Asked again, it works. A passkey from some other authenticator
    // does not.
    let mut stranger = SoftPasskey::new(false);
    let form = json!({ "password": PASSWORD });
    let (_, start, _) = bridge.post("/api/second-factor/passkey/start", form, Some(&session)).await;
    let options = serde_json::from_value(start["options"].clone()).unwrap();
    let theirs = stranger.do_registration(bridge.page_url(), options).unwrap();
    let (_, start, _) = bridge.post("/api/login/passkey/start", json!({}), Some(&pending)).await;
    let mut options: webauthn_rs::prelude::RequestChallengeResponse = serde_json::from_value(start["options"].clone()).unwrap();
    options.public_key.allow_credentials[0].id = theirs.raw_id.clone();
    let forged = json!({ "credential": stranger.do_authentication(bridge.page_url(), options).unwrap() });
    let (status, body, _) = bridge.post("/api/login/passkey/finish", forged, Some(&pending)).await;
    assert_eq!(status, 403, "{body}");
    let fresh = bridge.sign_passkey(&mut phone, &pending).await;
    let (status, body, _) = bridge.post("/api/login/passkey/finish", fresh, Some(&pending)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(passkey_counts(&bridge), [3]);

    // A second passkey, and an authenticator app beside them.
    let mut laptop = SoftPasskey::new(false);
    let second = bridge.add_passkey(&mut laptop, "", &session).await;
    let (_, enrolled) = bridge.get("/api/second-factor", Some(&session)).await;
    assert_eq!(enrolled["passkeys"][1]["name"], "Passkey");
    let (key, _) = bridge.enrol(&session).await;
    let pending = bridge.password_step_to(json!({ "totp": true, "passkey": true })).await;
    let signed = bridge.sign_passkey(&mut laptop, &pending).await;
    assert_eq!(bridge.post("/api/login/passkey/finish", signed, Some(&pending)).await.0, 200);
    let pending = bridge.password_step_to(json!({ "totp": true, "passkey": true })).await;
    let code = totp::code(&key, totp::step_now());
    assert_eq!(bridge.post("/api/login/totp", json!({ "code": code }), Some(&pending)).await.0, 200);

    // Removing takes the password, and the bridge's name for the passkey.
    let path = format!("/api/second-factor/passkey/{id}");
    assert_eq!(bridge.delete(&path, json!({ "password": PASSWORD }), None).await.0, 401);
    let gone = "/api/second-factor/passkey/ffffffffffffffff";
    assert_eq!(bridge.delete(gone, json!({ "password": PASSWORD }), Some(&session)).await.0, 404);
    assert_eq!(bridge.delete(&path, json!({ "password": PASSWORD }), Some(&session)).await.0, 200);
    assert_eq!(bridge.delete(&path, json!({ "password": PASSWORD }), Some(&session)).await.0, 404);
    // A removed passkey opens nothing, even for a challenge it was in.
    let pending = bridge.password_step_to(json!({ "totp": true, "passkey": true })).await;
    let (_, start, _) = bridge.post("/api/login/passkey/start", json!({}), Some(&pending)).await;
    assert_eq!(start["options"]["publicKey"]["allowCredentials"].as_array().unwrap().len(), 1);
    let signed = bridge.sign_passkey(&mut laptop, &pending).await;
    let path = format!("/api/second-factor/passkey/{second}");
    assert_eq!(bridge.delete(&path, json!({ "password": PASSWORD }), Some(&session)).await.0, 200);
    let (status, body, _) = bridge.post("/api/login/passkey/finish", signed, Some(&pending)).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(bridge.password_step().await.len(), "crt_pending=".len() + 64);
}

#[tokio::test]
async fn a_passkey_as_the_first_second_factor_closes_the_other_sessions_too() {
    let mock = mock_pve::start("127.0.0.1:0").await;
    let (bridge, cookie) = bridge_on_localhost("passkey-old-sessions", &mock).await;
    let (status, _, other) = bridge.post("/api/login", json!({ "password": PASSWORD }), None).await;
    assert_eq!(status, 200);
    let other = other.unwrap();
    assert_eq!(bridge.state(Some(&other)).await["authed"], true);

    let mut phone = SoftPasskey::new(false);
    bridge.add_passkey(&mut phone, "Phone", &cookie).await;
    assert_eq!(bridge.state(Some(&cookie)).await["authed"], true);
    assert_eq!(bridge.state(Some(&other)).await["authed"], false);

    // A session opened with the passkey stays when a second one is added.
    let pending = bridge.password_step_to(json!({ "totp": false, "passkey": true })).await;
    let signed = bridge.sign_passkey(&mut phone, &pending).await;
    let (status, _, second) = bridge.post("/api/login/passkey/finish", signed, Some(&pending)).await;
    assert_eq!(status, 200);
    let mut laptop = SoftPasskey::new(false);
    bridge.add_passkey(&mut laptop, "Laptop", &cookie).await;
    assert_eq!(bridge.state(second.as_deref()).await["authed"], true);
}

#[tokio::test]
async fn a_passkey_whose_count_went_backwards_is_refused() {
    let mock = mock_pve::start("127.0.0.1:0").await;
    let (bridge, cookie) = bridge_on_localhost("passkey-count", &mock).await;
    let mut phone = SoftPasskey::new(false);
    bridge.add_passkey(&mut phone, "Phone", &cookie).await;
    for uses in 1..=2 {
        let pending = bridge.password_step_to(json!({ "totp": false, "passkey": true })).await;
        let signed = bridge.sign_passkey(&mut phone, &pending).await;
        assert_eq!(bridge.post("/api/login/passkey/finish", signed, Some(&pending)).await.0, 200);
        assert_eq!(passkey_counts(&bridge), [uses]);
    }

    // A bridge that has seen the passkey used a thousand times takes the
    // third use for a copy's.
    let settings = std::fs::read_to_string(&bridge.config).unwrap();
    let port = bridge.addr.rsplit_once(':').unwrap().1;
    assert!(settings.contains("\"counter\":2,"), "{settings}");
    let settings = settings
        .replace("\"counter\":2,", "\"counter\":1000,")
        .replace(&format!("localhost:{port}"), "localhost:PORT");
    let mut later = bridge_with("passkey-count-later", Some(&settings)).await;
    later.page = Some(format!("http://localhost:{}", later.addr.rsplit_once(':').unwrap().1));
    let pending = later.password_step_to(json!({ "totp": false, "passkey": true })).await;
    let signed = later.sign_passkey(&mut phone, &pending).await;
    let (status, body, cookie) = later.post("/api/login/passkey/finish", signed, Some(&pending)).await;
    assert_eq!(status, 403, "{body}");
    assert!(cookie.is_none());
    assert_eq!(passkey_counts(&later), [1000]);
    // The reset flag's work takes passkeys off with the rest.
    assert!(proxmox_crt::reset_second_factor(&later.config).unwrap());
    assert!(config::Config::load(&later.config).unwrap().second_factor.is_empty());

    // A settings file with a passkey that cannot be read stops the bridge
    // from starting, rather than leave a way in that is not one.
    let broken = settings.replace("\"counter\":1000,", "\"counter\":\"many\",");
    let path = later.config.with_file_name("broken.toml");
    std::fs::write(&path, broken).unwrap();
    let options = Options {
        config: path,
        client: PathBuf::new(),
    };
    let refused = App::new(&options).err().expect("the bridge does not start").to_string();
    assert!(refused.contains("--reset-second-factor"), "{refused}");
}

#[tokio::test]
async fn passkeys_are_refused_where_a_browser_would_refuse_them() {
    const NEEDS: &str = "Passkeys need the page to be reached over https at its public address; set public_url";
    let mock = mock_pve::start("127.0.0.1:0").await;

    // On a plain LAN address, with no public_url.
    let bridge = bridge("passkey-lan").await;
    let cookie = bridge.set_up(&mock).await;
    assert_eq!(bridge.get("/api/second-factor", Some(&cookie)).await.1["passkeys_possible"], false);
    let form = json!({ "password": PASSWORD, "name": "Phone" });
    let (status, body, _) = bridge.post("/api/second-factor/passkey/start", form.clone(), Some(&cookie)).await;
    assert_eq!((status, body["error"].as_str()), (409, Some(NEEDS)));
    let (status, body, _) = bridge
        .post("/api/second-factor/passkey/finish", json!({ "credential": {} }), Some(&cookie))
        .await;
    assert!(status == 409 || status == 422, "{status} {body}");
    bridge.enrol(&cookie).await;
    let pending = bridge.password_step().await;
    let (status, body, _) = bridge.post("/api/login/passkey/start", json!({}), Some(&pending)).await;
    assert_eq!((status, body["error"].as_str()), (409, Some(NEEDS)));

    // With a public address, from a page opened at another: the bridge's
    // own LAN address, say.
    let (mut bridge, cookie) = bridge_on_localhost("passkey-origin", &mock).await;
    let at_public = bridge.page.replace(format!("http://{}", bridge.addr));
    let (status, body, _) = bridge.post("/api/second-factor/passkey/start", form.clone(), Some(&cookie)).await;
    assert_eq!((status, body["error"].as_str()), (403, Some(NEEDS)));
    // And from another site altogether, as every route.
    for step in ["second-factor/passkey/start", "login/passkey/start"] {
        let request = bridge.http.post(format!("http://{}/api/{step}", bridge.addr)).json(&form);
        let response = request.header("Origin", "https://elsewhere.example").send().await.unwrap();
        assert_eq!(response.status().as_u16(), 403, "{step}");
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["error"], "That request came from another site.", "{step}");
    }
    bridge.page = at_public;

    // At the public address: not without a session, nor without the
    // password, and a wrong one counts as a wrong guess.
    assert_eq!(bridge.post("/api/second-factor/passkey/start", form.clone(), None).await.0, 401);
    let (status, _, _) = bridge
        .post("/api/second-factor/passkey/start", json!({ "name": "Phone" }), Some(&cookie))
        .await;
    assert_eq!(status, 422);
    let wrong = json!({ "password": "wrong horse", "name": "Phone" });
    let (status, body, _) = bridge.post("/api/second-factor/passkey/start", wrong, Some(&cookie)).await;
    assert_eq!((status, body["error"].as_str()), (403, Some("Wrong password.")));
    let gone = "/api/second-factor/passkey/ffffffffffffffff";
    let wrong = json!({ "password": "wrong horse" });
    assert_eq!(bridge.delete(gone, wrong, Some(&cookie)).await.0, 403);
    let long = json!({ "password": PASSWORD, "name": "x".repeat(41) });
    assert_eq!(bridge.post("/api/second-factor/passkey/start", long, Some(&cookie)).await.0, 400);

    // An answer with no challenge out is refused, and so is one that is
    // not a passkey's; nothing is saved by either.
    let mut phone = SoftPasskey::new(false);
    let (_, start, _) = bridge.post("/api/second-factor/passkey/start", form.clone(), Some(&cookie)).await;
    let options: webauthn_rs::prelude::CreationChallengeResponse = serde_json::from_value(start["options"].clone()).unwrap();
    let made = phone.do_registration(bridge.page_url(), options.clone()).unwrap();
    // Logging out takes the challenge with it.
    assert_eq!(bridge.post("/api/logout", json!({}), Some(&cookie)).await.0, 200);
    let cookie = bridge.post("/api/login", json!({ "password": PASSWORD }), None).await.2.unwrap();
    let (status, body, _) = bridge
        .post("/api/second-factor/passkey/finish", json!({ "credential": made }), Some(&cookie))
        .await;
    assert_eq!(status, 409, "{body}");
    // Signed for another address than the page's.
    let (_, start, _) = bridge.post("/api/second-factor/passkey/start", form, Some(&cookie)).await;
    let options = serde_json::from_value(start["options"].clone()).unwrap();
    let elsewhere = Url::parse("http://localhost:1").unwrap();
    let made = phone.do_registration(elsewhere, options).unwrap();
    let (status, body, _) = bridge
        .post("/api/second-factor/passkey/finish", json!({ "credential": made }), Some(&cookie))
        .await;
    assert_eq!(status, 400, "{body}");
    assert!(
        body["error"].as_str().unwrap().starts_with("That passkey could not be added"),
        "{body}"
    );
    assert!(config::Config::load(&bridge.config).unwrap().second_factor.is_empty());
    assert_eq!(
        bridge.post("/api/login", json!({ "password": PASSWORD }), None).await.1,
        json!({ "ok": true })
    );
}

const CLIENT_ID: &str = "wall";
const CLIENT_SECRET: &str = "s3cret";

/// A stand-in single sign-on provider: it says where its endpoints are,
/// shows its public key, and trades a code it handed out for the ID token
/// that goes with it, if the code comes with what PKCE asks for.
struct Provider {
    issuer: String,
    /// The key it signs with now. It can take a new one, as providers do.
    key: Mutex<CoreEdDsaPrivateSigningKey>,
    /// How often it was asked what it is, and for its keys.
    asked: AtomicUsize,
    keys_read: AtomicUsize,
    /// Whether it is out of order, and for how long it thinks before it
    /// says so.
    down: AtomicBool,
    /// The codes handed out and not traded in yet: the ID token each is
    /// for, and the PKCE challenge the sign-in began with.
    codes: Mutex<HashMap<String, (String, String)>>,
}

fn signing_key() -> CoreEdDsaPrivateSigningKey {
    let pair = rcgen::KeyPair::generate_for(&rcgen::PKCS_ED25519).unwrap();
    CoreEdDsaPrivateSigningKey::from_ed25519_pem(&pair.serialize_pem(), None).unwrap()
}

async fn provider() -> Arc<Provider> {
    use axum::extract::State;
    use axum::http::HeaderMap;
    use axum::routing::{get, post};
    use axum::{Form, Json};

    async fn metadata(State(provider): State<Arc<Provider>>) -> Result<Json<Value>, axum::http::StatusCode> {
        provider.asked.fetch_add(1, Ordering::SeqCst);
        if provider.down.load(Ordering::SeqCst) {
            // Long enough for everyone who asks meanwhile to pile up.
            tokio::time::sleep(Duration::from_millis(300)).await;
            return Err(axum::http::StatusCode::SERVICE_UNAVAILABLE);
        }
        let issuer = &provider.issuer;
        Ok(Json(json!({
            "issuer": issuer,
            "authorization_endpoint": format!("{issuer}/authorize"),
            "token_endpoint": format!("{issuer}/token"),
            "jwks_uri": format!("{issuer}/keys"),
            "response_types_supported": ["code"],
            "subject_types_supported": ["public"],
            // More than a careful client takes.
            "id_token_signing_alg_values_supported": ["EdDSA", "HS256", "none"],
        })))
    }

    async fn keys(State(provider): State<Arc<Provider>>) -> Json<CoreJsonWebKeySet> {
        provider.keys_read.fetch_add(1, Ordering::SeqCst);
        Json(CoreJsonWebKeySet::new(vec![provider.key.lock().unwrap().as_verification_key()]))
    }

    async fn token(
        State(provider): State<Arc<Provider>>,
        headers: HeaderMap,
        Form(form): Form<HashMap<String, String>>,
    ) -> (axum::http::StatusCode, Json<Value>) {
        let no = |why: &str| (axum::http::StatusCode::BAD_REQUEST, Json(json!({ "error": why })));
        let client = format!("Basic {}", BASE64.encode(format!("{CLIENT_ID}:{CLIENT_SECRET}").as_bytes()));
        if headers.get("authorization").and_then(|v| v.to_str().ok()) != Some(client.as_str()) {
            return no("invalid_client");
        }
        if form.get("grant_type").map(String::as_str) != Some("authorization_code") {
            return no("unsupported_grant_type");
        }
        let code = form.get("code").and_then(|code| provider.codes.lock().unwrap().remove(code));
        let (Some((id_token, challenge)), Some(verifier)) = (code, form.get("code_verifier")) else {
            return no("invalid_grant");
        };
        if BASE64URL_NOPAD.encode(&Sha256::digest(verifier.as_bytes())) != challenge {
            return no("invalid_grant");
        }
        let answer = json!({ "access_token": "not-used", "token_type": "Bearer", "id_token": id_token });
        (axum::http::StatusCode::OK, Json(answer))
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let provider = Arc::new(Provider {
        issuer: format!("http://{}", listener.local_addr().unwrap()),
        key: Mutex::new(signing_key()),
        asked: AtomicUsize::new(0),
        keys_read: AtomicUsize::new(0),
        down: AtomicBool::new(false),
        codes: Mutex::new(HashMap::new()),
    });
    let routes = axum::Router::new()
        .route("/.well-known/openid-configuration", get(metadata))
        .route("/keys", get(keys))
        .route("/token", post(token))
        .with_state(provider.clone());
    tokio::spawn(async move { axum::serve(listener, routes).await });
    provider
}

/// A token in the compact form: a header, the claims and a signature over
/// the two.
fn jwt(alg: &str, claims: &Value, sign: impl Fn(&[u8]) -> Vec<u8>) -> String {
    let header = json!({ "alg": alg, "typ": "JWT" });
    let signed = format!(
        "{}.{}",
        BASE64URL_NOPAD.encode(header.to_string().as_bytes()),
        BASE64URL_NOPAD.encode(claims.to_string().as_bytes())
    );
    format!("{signed}.{}", BASE64URL_NOPAD.encode(&sign(signed.as_bytes())))
}

impl Provider {
    /// An ID token with the provider's own signature.
    fn signed(&self, claims: &Value) -> String {
        let key = self.key.lock().unwrap();
        jwt("EdDSA", claims, |text| key.sign(&CoreJwsSigningAlgorithm::EdDsa, text).unwrap())
    }

    /// Hands out a code for `id_token`, as the provider does once someone
    /// has signed in to it.
    fn code_for(&self, id_token: String, challenge: &str) -> String {
        let code = proxmox_crt::auth::random_hex(16);
        let mut codes = self.codes.lock().unwrap();
        codes.insert(code.clone(), (id_token, challenge.to_string()));
        code
    }

    /// The settings of a bridge that signs in through this provider and
    /// lets in `allow`.
    fn settings(&self, allow: &str) -> String {
        format!(
            "public_url = \"http://127.0.0.1:PORT\"\n\n[oidc]\nissuer = \"{}\"\nclient_id = \"{CLIENT_ID}\"\nclient_secret = \"{CLIENT_SECRET}\"\nallow = {allow}\n",
            self.issuer
        )
    }
}

/// A sign-in that the bridge has sent to the provider: the cookie the
/// browser was given, and what the provider was sent along.
struct Away {
    cookie: String,
    state: String,
    nonce: String,
    challenge: String,
}

/// What a browser got back: the status, the cookies that were set, and
/// the page.
type Landed = (u16, Vec<String>, String);

impl Bridge {
    /// A browser that says where it is sent in place of going there.
    fn browser(&self) -> reqwest::Client {
        let stay = reqwest::redirect::Policy::none();
        reqwest::Client::builder().redirect(stay).build().unwrap()
    }

    async fn visit(&self, path: &str, cookie: Option<&str>) -> reqwest::Response {
        let mut request = self.browser().get(format!("http://{}{path}", self.addr));
        if let Some(cookie) = cookie {
            request = request.header("Cookie", cookie);
        }
        request.send().await.unwrap()
    }

    /// Presses the provider's button, and follows it as far as the
    /// provider's door.
    async fn leave(&self, provider: &Provider) -> Away {
        let response = self.visit("/api/oidc/start", None).await;
        assert_eq!(response.status().as_u16(), 303);
        let set = response.headers()["set-cookie"].to_str().unwrap();
        // It has to come back from the provider's site, so it is lax.
        assert!(set.ends_with("; Path=/; Max-Age=600; HttpOnly; SameSite=Lax"), "{set}");
        let cookie = set.split(';').next().unwrap().to_string();
        assert!(cookie.starts_with("crt_oidc="), "{cookie}");
        let to = Url::parse(response.headers()["location"].to_str().unwrap()).unwrap();
        assert!(to.as_str().starts_with(&format!("{}/authorize?", provider.issuer)), "{to}");
        let sent: HashMap<String, String> = to.query_pairs().into_owned().collect();
        assert_eq!(sent["response_type"], "code");
        assert_eq!(sent["client_id"], CLIENT_ID);
        assert_eq!(sent["redirect_uri"], format!("http://{}/api/oidc/callback", self.addr));
        assert_eq!(sent["scope"], "openid email");
        assert_eq!(sent["code_challenge_method"], "S256");
        assert!(sent["state"].len() >= 22 && sent["nonce"].len() >= 22, "{to}");
        assert!(!to.as_str().contains(CLIENT_SECRET));
        Away {
            cookie,
            state: sent["state"].clone(),
            nonce: sent["nonce"].clone(),
            challenge: sent["code_challenge"].clone(),
        }
    }

    /// What the provider would say of the tests' owner to this bridge, for
    /// the sign-in that is `away`.
    fn claims(&self, provider: &Provider, away: &Away) -> Value {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        json!({
            "iss": provider.issuer,
            "sub": "1000",
            "aud": CLIENT_ID,
            "iat": now,
            "exp": now + 300,
            "nonce": away.nonce,
            "email": "owner@example.com",
            "email_verified": true,
        })
    }

    /// Comes back from the provider with `query`.
    async fn land(&self, cookie: Option<&str>, query: &str) -> Landed {
        let response = self.visit(&format!("/api/oidc/callback?{query}"), cookie).await;
        let status = response.status().as_u16();
        assert!(response.headers()["content-type"].to_str().unwrap().starts_with("text/html"));
        assert_eq!(response.headers()["cache-control"], "no-store");
        let cookies = response.headers().get_all("set-cookie");
        let cookies = cookies.iter().map(|c| c.to_str().unwrap().to_string()).collect();
        (status, cookies, response.text().await.unwrap())
    }

    /// A whole sign-in, in which the provider answers with `id_token`.
    async fn come_back_with(&self, provider: &Provider, away: &Away, id_token: String) -> Landed {
        let code = provider.code_for(id_token, &away.challenge);
        self.land(Some(&away.cookie), &format!("code={code}&state={}", away.state)).await
    }

    /// A whole sign-in as someone the provider describes with the
    /// owner's claims after `alter` has had its way with them.
    async fn sign_in_as(&self, provider: &Provider, alter: impl FnOnce(&mut Value)) -> Landed {
        let away = self.leave(provider).await;
        let mut claims = self.claims(provider, &away);
        alter(&mut claims);
        self.come_back_with(provider, &away, provider.signed(&claims)).await
    }
}

/// The session a landing opened, if it opened one.
fn session_of(landed: &Landed) -> Option<String> {
    let opened = landed
        .1
        .iter()
        .find(|c| c.starts_with("crt_session=") && !c.starts_with("crt_session=;"))?;
    Some(opened.split(';').next().unwrap().to_string())
}

#[tokio::test]
async fn single_sign_on_opens_a_session_for_who_is_on_the_list() {
    let mock = mock_pve::start("127.0.0.1:0").await;
    let provider = provider().await;
    let bridge = bridge_with("oidc", Some(&provider.settings("[\"Owner@Example.com\", \"sub:42\"]"))).await;

    // Before anyone is let in the page learns which ways in there are,
    // and no more.
    let state = bridge.state(None).await;
    assert_eq!(state["oidc"], json!({ "label": "Sign in with single sign-on" }));
    assert_eq!(state["password_login"], true);
    assert_eq!(state["authed"], false);
    assert_eq!(state["https_only"], false);
    assert_eq!(state.as_object().unwrap().len(), 6, "{state}");
    assert!(!state.to_string().contains(&provider.issuer));

    let landed = bridge.sign_in_as(&provider, |_| {}).await;
    assert_eq!(landed.0, 200, "{}", landed.2);
    // The session's cookie is as strict as ever, the sign-in's is cleared,
    // and the page goes on to the wall by itself.
    assert!(landed.1[0].starts_with("crt_session="), "{:?}", landed.1);
    assert!(landed.1[0].ends_with("; HttpOnly; SameSite=Strict"), "{:?}", landed.1);
    assert!(
        landed.1.iter().any(|c| c.starts_with("crt_oidc=; Path=/; Max-Age=0;")),
        "{:?}",
        landed.1
    );
    assert!(
        landed.2.contains("<meta http-equiv=\"refresh\" content=\"0; url=../../\">"),
        "{}",
        landed.2
    );
    assert!(landed.2.contains("<a href=\"../../\">"), "{}", landed.2);
    let session = session_of(&landed).unwrap();
    assert_eq!(bridge.state(Some(&session)).await["authed"], true);
    assert!(bridge.socket("/api/feed", Some(&session)).await.is_ok());
    // The code was traded in, once.
    assert!(provider.codes.lock().unwrap().is_empty());

    // An address is the same in any case, and an account can be listed by
    // the provider's own name for it, address or none.
    let landed = bridge
        .sign_in_as(&provider, |claims| claims["email"] = json!("OWNER@example.COM"))
        .await;
    assert!(session_of(&landed).is_some(), "{}", landed.2);
    let landed = bridge
        .sign_in_as(&provider, |claims| {
            claims["sub"] = json!("42");
            claims.as_object_mut().unwrap().remove("email");
            claims.as_object_mut().unwrap().remove("email_verified");
        })
        .await;
    assert!(session_of(&landed).is_some(), "{}", landed.2);

    // The settings card is told that it is on and through whom, not the
    // client's secret nor who is let in.
    let (_, enrolled) = bridge.get("/api/second-factor", Some(&session)).await;
    assert_eq!(enrolled["oidc"], json!({ "issuer": provider.issuer }));
    assert_eq!(enrolled["oidc_possible"], true);
    assert_eq!(enrolled["password_login"], true);
    assert!(!enrolled.to_string().contains(CLIENT_SECRET) && !enrolled.to_string().contains("sub:42"));

    // The provider has asked for whatever second step it asks for, so the
    // bridge asks for none: the password earns the second step, a sign-in
    // through the provider the session.
    let cookie = bridge.set_up(&mock).await;
    bridge.enrol(&cookie).await;
    bridge.password_step().await;
    let landed = bridge.sign_in_as(&provider, |_| {}).await;
    let session = session_of(&landed).unwrap();
    assert_eq!(bridge.state(Some(&session)).await["authed"], true);
    assert!(
        landed
            .1
            .iter()
            .all(|c| !c.starts_with("crt_pending=") || c.starts_with("crt_pending=;"))
    );
    // What the bridge wrote of the second factor left the hand-written
    // settings as they were.
    let saved = config::Config::load(&bridge.config).unwrap();
    assert_eq!(saved.oidc.unwrap().allow, ["Owner@Example.com", "sub:42"]);
}

#[tokio::test]
async fn single_sign_on_refuses_what_does_not_check_out() {
    let provider = provider().await;
    let bridge = bridge_with("oidc-refused", Some(&provider.settings("[\"owner@example.com\"]"))).await;
    const NOT_STARTED: &str = "That sign-in was not started here, or took too long. Try again.";
    const NOT_CONFIRMED: &str = "The provider did not confirm who you are.";
    const NOT_ALLOWED: &str = "This account is not allowed here.";
    // A refusal says why in the bridge's own words, opens nothing, and
    // ends the sign-in.
    let refused = |landed: Landed, status: u16, why: &str, what: &str| {
        assert_eq!(landed.0, status, "{what}: {}", landed.2);
        assert!(landed.2.contains(why), "{what}: {}", landed.2);
        assert!(session_of(&landed).is_none(), "{what}");
        assert!(
            landed.1.iter().all(|c| c.starts_with("crt_oidc=; Path=/; Max-Age=0;")),
            "{what}: {:?}",
            landed.1
        );
        assert!(!landed.2.contains("http-equiv"), "{what}");
    };

    // The answer has to carry the state this browser's sign-in left with.
    let away = bridge.leave(&provider).await;
    let token = provider.signed(&bridge.claims(&provider, &away));
    let code = provider.code_for(token.clone(), &away.challenge);
    let other = bridge.leave(&provider).await;
    let landed = bridge.land(Some(&away.cookie), &format!("code={code}&state={}", other.state)).await;
    refused(landed, 400, NOT_STARTED, "wrong state");
    // A wrong answer used the sign-in up: the right one is too late.
    let landed = bridge.land(Some(&away.cookie), &format!("code={code}&state={}", away.state)).await;
    refused(landed, 400, NOT_STARTED, "state after a wrong one");
    assert_eq!(provider.codes.lock().unwrap().len(), 1);
    // Another browser's state is no better with one's own cookie, nor any
    // state with no cookie, nor a cookie with no state.
    let landed = bridge.land(Some(&other.cookie), &format!("code={code}&state={}", away.state)).await;
    refused(landed, 400, NOT_STARTED, "another sign-in's state");
    let away = bridge.leave(&provider).await;
    let landed = bridge.land(None, &format!("code={code}&state={}", away.state)).await;
    refused(landed, 400, NOT_STARTED, "no cookie");
    let landed = bridge.land(Some(&away.cookie), &format!("code={code}")).await;
    refused(landed, 400, NOT_STARTED, "no state");

    // A sign-in that worked is not answered a second time.
    let away = bridge.leave(&provider).await;
    let token = provider.signed(&bridge.claims(&provider, &away));
    let code = provider.code_for(token.clone(), &away.challenge);
    let query = format!("code={code}&state={}", away.state);
    assert!(session_of(&bridge.land(Some(&away.cookie), &query).await).is_some());
    refused(bridge.land(Some(&away.cookie), &query).await, 400, NOT_STARTED, "replayed");
    // Nor is its token good for the next one, which sent another nonce.
    let next = bridge.leave(&provider).await;
    let landed = bridge.come_back_with(&provider, &next, token).await;
    refused(landed, 403, NOT_CONFIRMED, "another sign-in's token");

    // What the token says has to be for this sign-in, this bridge, from
    // this provider, and still good.
    let landed = bridge
        .sign_in_as(&provider, |claims| claims["nonce"] = json!("some-other-nonce"))
        .await;
    refused(landed, 403, NOT_CONFIRMED, "wrong nonce");
    let landed = bridge
        .sign_in_as(&provider, |claims| {
            claims.as_object_mut().unwrap().remove("nonce");
        })
        .await;
    refused(landed, 403, NOT_CONFIRMED, "no nonce");
    let landed = bridge
        .sign_in_as(&provider, |claims| claims["aud"] = json!("some-other-client"))
        .await;
    refused(landed, 403, NOT_CONFIRMED, "wrong audience");
    let landed = bridge
        .sign_in_as(&provider, |claims| claims["aud"] = json!([CLIENT_ID, "some-other-client"]))
        .await;
    refused(landed, 403, NOT_CONFIRMED, "a second audience");
    let landed = bridge
        .sign_in_as(&provider, |claims| claims["iss"] = json!("https://elsewhere.example"))
        .await;
    refused(landed, 403, NOT_CONFIRMED, "wrong issuer");
    let landed = bridge
        .sign_in_as(&provider, |claims| {
            claims["exp"] = json!(claims["iat"].as_u64().unwrap() - 60);
            claims["iat"] = json!(claims["iat"].as_u64().unwrap() - 360);
        })
        .await;
    refused(landed, 403, NOT_CONFIRMED, "expired");

    // And it has to be signed with the provider's key: not someone
    // else's, not the client's own secret, not nothing, whatever the
    // provider's metadata offers.
    let away = bridge.leave(&provider).await;
    let claims = bridge.claims(&provider, &away);
    let stranger = signing_key();
    let forged = jwt("EdDSA", &claims, |text| {
        stranger.sign(&CoreJwsSigningAlgorithm::EdDsa, text).unwrap()
    });
    let landed = bridge.come_back_with(&provider, &away, forged).await;
    refused(landed, 403, NOT_CONFIRMED, "bad signature");
    let away = bridge.leave(&provider).await;
    let mut tampered = bridge.claims(&provider, &away);
    let honest = provider.signed(&tampered);
    tampered["sub"] = json!("1001");
    let body = BASE64URL_NOPAD.encode(tampered.to_string().as_bytes());
    let parts: Vec<&str> = honest.split('.').collect();
    let landed = bridge
        .come_back_with(&provider, &away, format!("{}.{body}.{}", parts[0], parts[2]))
        .await;
    refused(landed, 403, NOT_CONFIRMED, "changed after signing");
    let away = bridge.leave(&provider).await;
    let claims = bridge.claims(&provider, &away);
    let secret = CoreHmacKey::new(CLIENT_SECRET);
    let forged = jwt("HS256", &claims, |text| {
        secret.sign(&CoreJwsSigningAlgorithm::HmacSha256, text).unwrap()
    });
    let landed = bridge.come_back_with(&provider, &away, forged).await;
    refused(landed, 403, NOT_CONFIRMED, "signed with the client's secret");
    let away = bridge.leave(&provider).await;
    let unsigned = jwt("none", &bridge.claims(&provider, &away), |_| Vec::new());
    let landed = bridge.come_back_with(&provider, &away, unsigned).await;
    refused(landed, 403, NOT_CONFIRMED, "not signed");

    // A good token for an account that is not on the list, or whose
    // address the provider has not verified, opens nothing either.
    let landed = bridge
        .sign_in_as(&provider, |claims| claims["email"] = json!("stranger@example.com"))
        .await;
    refused(landed, 403, NOT_ALLOWED, "not on the list");
    let landed = bridge.sign_in_as(&provider, |claims| claims["email_verified"] = json!(false)).await;
    refused(landed, 403, NOT_ALLOWED, "unverified address");
    let landed = bridge
        .sign_in_as(&provider, |claims| {
            claims.as_object_mut().unwrap().remove("email_verified");
        })
        .await;
    refused(landed, 403, NOT_ALLOWED, "address not said to be verified");
    let landed = bridge
        .sign_in_as(&provider, |claims| claims["sub"] = json!("owner@example.com"))
        .await;
    assert!(session_of(&landed).is_some(), "the subject is not what is compared");
    let landed = bridge
        .sign_in_as(&provider, |claims| {
            claims["sub"] = json!("owner@example.com");
            claims["email"] = json!("stranger@example.com");
        })
        .await;
    refused(landed, 403, NOT_ALLOWED, "an address for a subject");

    // A code the provider does not know, and the provider's own refusal,
    // whose words are not repeated on the page.
    let away = bridge.leave(&provider).await;
    let landed = bridge.land(Some(&away.cookie), &format!("code=made-up&state={}", away.state)).await;
    refused(landed, 502, NOT_CONFIRMED, "unknown code");
    let away = bridge.leave(&provider).await;
    let said = "error=access_denied&error_description=%3Cscript%3Ealert(1)%3C%2Fscript%3E";
    let landed = bridge.land(Some(&away.cookie), &format!("{said}&state={}", away.state)).await;
    assert!(!landed.2.contains("script") && !landed.2.contains("access_denied"), "{}", landed.2);
    refused(landed, 403, NOT_CONFIRMED, "the provider's refusal");

    // An empty list lets nobody in, and a bridge with no provider has no
    // such door.
    let nobody = bridge_with("oidc-nobody", Some(&provider.settings("[]"))).await;
    refused(nobody.sign_in_as(&provider, |_| {}).await, 403, NOT_ALLOWED, "empty list");
    let plain = bridge_with("oidc-none", None).await;
    let state = plain.state(None).await;
    assert_eq!((&state["oidc"], &state["password_login"]), (&Value::Null, &json!(true)));
    assert_eq!(plain.visit("/api/oidc/start", None).await.status().as_u16(), 404);
    assert_eq!(plain.land(None, "code=x&state=y").await.0, 404);

    // Nothing above opened a session by the back door.
    assert_eq!(bridge.state(Some(&away.cookie)).await["authed"], false);
    let as_session = away.cookie.replace("crt_oidc=", "crt_session=");
    assert_eq!(bridge.state(Some(&as_session)).await["authed"], false);
}

#[tokio::test]
async fn a_sign_in_that_is_away_is_not_crowded_out_by_others_starting() {
    let provider = provider().await;
    let bridge = bridge_with("oidc-crowd", Some(&provider.settings("[\"owner@example.com\"]"))).await;
    // The owner has pressed the button and is at the provider. Meanwhile
    // someone who has no account anywhere presses it over and over.
    let away = bridge.leave(&provider).await;
    let browser = bridge.browser();
    for _ in 0..600 {
        let response = browser.get(format!("http://{}/api/oidc/start", bridge.addr)).send().await.unwrap();
        assert_eq!(response.status().as_u16(), 303);
    }
    let token = provider.signed(&bridge.claims(&provider, &away));
    let landed = bridge.come_back_with(&provider, &away, token).await;
    assert_eq!(landed.0, 200, "{}", landed.2);
    assert!(session_of(&landed).is_some());
    // All of that asked the provider what it is once.
    assert_eq!(provider.asked.load(Ordering::SeqCst), 1);
    assert_eq!(provider.keys_read.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_provider_that_changed_its_key_is_asked_for_its_keys_again() {
    let provider = provider().await;
    let bridge = bridge_with("oidc-new-key", Some(&provider.settings("[\"owner@example.com\"]"))).await;
    assert!(session_of(&bridge.sign_in_as(&provider, |_| {}).await).is_some());
    assert_eq!(provider.keys_read.load(Ordering::SeqCst), 1);

    // The provider begins to sign with a new key, minutes before the
    // bridge would read its keys again by itself. The next sign-in has it
    // read them at once, and is let in.
    *provider.key.lock().unwrap() = signing_key();
    let landed = bridge.sign_in_as(&provider, |_| {}).await;
    assert_eq!(landed.0, 200, "{}", landed.2);
    assert!(session_of(&landed).is_some());
    assert_eq!(provider.keys_read.load(Ordering::SeqCst), 2);
    assert!(session_of(&bridge.sign_in_as(&provider, |_| {}).await).is_some());
    assert_eq!(provider.keys_read.load(Ordering::SeqCst), 2);

    // Tokens signed by someone else do not have the bridge ask the
    // provider each time: it asked a moment ago.
    for _ in 0..3 {
        let away = bridge.leave(&provider).await;
        let stranger = signing_key();
        let forged = jwt("EdDSA", &bridge.claims(&provider, &away), |text| {
            stranger.sign(&CoreJwsSigningAlgorithm::EdDsa, text).unwrap()
        });
        let landed = bridge.come_back_with(&provider, &away, forged).await;
        assert_eq!(landed.0, 403, "{}", landed.2);
        assert!(session_of(&landed).is_none());
    }
    assert_eq!(provider.keys_read.load(Ordering::SeqCst), 2);
    assert_eq!(provider.asked.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_provider_that_is_down_is_asked_once_for_all_who_wait() {
    let provider = provider().await;
    let bridge = bridge_with("oidc-down", Some(&provider.settings("[\"owner@example.com\"]"))).await;
    provider.down.store(true, Ordering::SeqCst);
    // Many press the button at once, and again straight after. Each is
    // told the provider cannot be reached, and the provider was asked
    // once.
    let browser = bridge.browser();
    let press = || {
        let request = browser.get(format!("http://{}/api/oidc/start", bridge.addr));
        async move { request.send().await.unwrap().status().as_u16() }
    };
    let together = futures_util::future::join_all((0..20).map(|_| press())).await;
    assert!(together.iter().all(|status| *status == 502), "{together:?}");
    assert_eq!(press().await, 502);
    assert_eq!(provider.asked.load(Ordering::SeqCst), 1);

    // It is asked again a few seconds later, and found well.
    provider.down.store(false, Ordering::SeqCst);
    assert_eq!(press().await, 502);
    tokio::time::sleep(Duration::from_millis(5200)).await;
    let together = futures_util::future::join_all((0..20).map(|_| press())).await;
    assert!(together.iter().all(|status| *status == 303), "{together:?}");
    assert_eq!(provider.asked.load(Ordering::SeqCst), 2);
    assert_eq!(provider.keys_read.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn with_password_login_off_the_provider_is_the_only_way_in() {
    let mock = mock_pve::start("127.0.0.1:0").await;
    let provider = provider().await;
    let settings = format!(
        "{}label = \"Sign in with Example\"\npassword_login = false\n",
        provider.settings("[\"owner@example.com\"]")
    );
    let bridge = bridge_with("oidc-only", Some(&settings)).await;

    // The setup card still works, with its code and its password.
    let state = bridge.state(None).await;
    assert_eq!(state["configured"], false);
    assert_eq!(state["password_login"], false);
    assert_eq!(state["oidc"], json!({ "label": "Sign in with Example" }));
    let cookie = bridge.set_up(&mock).await;
    assert_eq!(bridge.state(Some(&cookie)).await["authed"], true);
    assert_eq!(bridge.get("/api/second-factor", Some(&cookie)).await.1["password_login"], false);
    bridge.post("/api/logout", json!({}), Some(&cookie)).await;

    // After that the right password opens nothing, and is not even looked
    // at: wrong ones do not use up guesses.
    for password in [
        PASSWORD,
        "wrong horse",
        "wrong horse",
        "wrong horse",
        "wrong horse",
        "wrong horse",
        PASSWORD,
    ] {
        let (status, body, cookie) = bridge.post("/api/login", json!({ "password": password }), None).await;
        assert_eq!(status, 403, "{body}");
        assert_eq!(body["error"], "Logging in by password is turned off here. Use single sign-on.");
        assert!(cookie.is_none());
    }
    let landed = bridge.sign_in_as(&provider, |_| {}).await;
    let session = session_of(&landed).unwrap();
    assert_eq!(bridge.state(Some(&session)).await["authed"], true);

    // Whoever can get at the machine can turn the password back on.
    let run = |config: PathBuf| {
        std::process::Command::new(env!("CARGO_BIN_EXE_proxmox-crt"))
            .arg("--enable-password-login")
            .arg("--config")
            .arg(config)
            .output()
            .unwrap()
    };
    let before = config::Config::load(&bridge.config).unwrap();
    let output = run(bridge.config.clone());
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert!(String::from_utf8_lossy(&output.stdout).contains("back on"));
    let after = config::Config::load(&bridge.config).unwrap();
    assert!(after.password_login());
    let mut expected = before.clone();
    expected.oidc.as_mut().unwrap().password_login = true;
    assert_eq!(after, expected);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&bridge.config).unwrap().permissions().mode() & 0o777, 0o600);
    }
    // A bridge started on that file takes the password again.
    let app = App::new(&Options {
        config: bridge.config.clone(),
        client: bridge.config.with_file_name("client"),
    })
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(proxmox_crt::serve(app, bridge.config.with_file_name("client"), listener));
    let response = bridge
        .http
        .post(format!("http://{addr}/api/login"))
        .json(&json!({ "password": PASSWORD }))
        .send()
        .await
        .unwrap();
    assert!(response.headers()["set-cookie"].to_str().unwrap().starts_with("crt_session="));

    // With nothing to turn on it says so, and it makes no file of its own.
    let output = run(bridge.config.clone());
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("not turned off"));
    let missing = bridge.config.with_file_name("missing.toml");
    assert!(!run(missing.clone()).status.success());
    assert!(!missing.exists());

    // Settings that could let nobody in stop the bridge from starting:
    // the provider cannot send a browser back to a plain LAN address.
    let lan = settings.replace("http://127.0.0.1:PORT", "http://192.168.1.20:8086");
    let path = bridge.config.with_file_name("lan.toml");
    std::fs::write(&path, lan).unwrap();
    let options = Options {
        config: path,
        client: PathBuf::new(),
    };
    let refused = App::new(&options).err().expect("the bridge does not start").to_string();
    assert!(refused.contains("public_url"), "{refused}");
}

#[tokio::test]
async fn the_feed_carries_readings_of_the_cluster() {
    let mock = mock_pve::start("127.0.0.1:0").await;
    let bridge = bridge("feed").await;
    let cookie = bridge.set_up(&mock).await;

    assert_eq!(bridge.socket("/api/feed", None).await.err(), Some(401));

    let mut feed = bridge.socket("/api/feed", Some(&cookie)).await.unwrap();
    let Message::Text(text) = next(&mut feed).await else {
        panic!("not text")
    };
    let message: Value = serde_json::from_str(text.as_str()).unwrap();
    let snapshot = &message["snapshot"];
    let guests = snapshot["guests"].as_array().unwrap();
    // 46 containers and 2 VMs; the template and the storage are not guests.
    assert_eq!(guests.len(), 48);
    assert!(guests.iter().all(|g| g["vmid"] != 999));
    let pihole = guests.iter().find(|g| g["vmid"] == 100).unwrap();
    assert_eq!(pihole["name"], "pihole");
    assert_eq!(pihole["type"], "lxc");
    assert_eq!(pihole["status"], "running");
    assert!(pihole["maxmem"].as_f64().unwrap() > 0.0);
    assert_eq!(guests.iter().filter(|g| g["status"] == "stopped").count(), 3);
    assert_eq!(guests.iter().filter(|g| g["type"] == "qemu").count(), 2);

    let nodes = snapshot["nodes"].as_array().unwrap();
    assert_eq!(nodes.len(), 3);
    assert_eq!(nodes[0]["node"], "pve1");
    assert_eq!(pihole["node"], "pve1");
    assert_eq!(nodes[0]["status"], "online");
    assert_eq!(nodes[0]["loadavg"].as_array().unwrap().len(), 3);
    assert!(nodes[0]["loadavg"][0].is_number());

    // A guest stopped on the host shows as stopped in a later reading.
    mock.mock.set_running(100, false);
    let stopped = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let Message::Text(text) = next(&mut feed).await else { continue };
            let message: Value = serde_json::from_str(text.as_str()).unwrap();
            let guests = message["snapshot"]["guests"].as_array().unwrap().clone();
            if guests.iter().any(|g| g["vmid"] == 100 && g["status"] == "stopped") {
                break true;
            }
        }
    })
    .await;
    assert_eq!(stopped, Ok(true));
}

#[tokio::test]
async fn the_power_route_starts_and_stops_a_guest() {
    let mock = mock_pve::start("127.0.0.1:0").await;
    let bridge = bridge("power").await;
    let cookie = bridge.set_up(&mock).await;

    // Not without logging in, and only the three actions there are.
    assert_eq!(bridge.post("/api/guest/100/power", json!({ "action": "stop" }), None).await.0, 401);
    assert_eq!(
        bridge
            .post("/api/guest/100/power", json!({ "action": "reboot" }), Some(&cookie))
            .await
            .0,
        400
    );
    assert_eq!(
        bridge
            .post("/api/guest/5/power", json!({ "action": "start" }), Some(&cookie))
            .await
            .0,
        404
    );

    let mut feed = bridge.socket("/api/feed", Some(&cookie)).await.unwrap();
    async fn status_becomes(feed: &mut Socket, vmid: u64, want: &str) -> bool {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let Message::Text(text) = next(feed).await else { continue };
                let message: Value = serde_json::from_str(text.as_str()).unwrap();
                let guests = message["snapshot"]["guests"].as_array().unwrap().clone();
                if guests.iter().any(|g| g["vmid"] == vmid && g["status"] == want) {
                    break true;
                }
            }
        })
        .await
            == Ok(true)
    }
    assert!(status_becomes(&mut feed, 100, "running").await);
    assert_eq!(
        bridge
            .post("/api/guest/100/power", json!({ "action": "shutdown" }), Some(&cookie))
            .await
            .0,
        200
    );
    assert!(status_becomes(&mut feed, 100, "stopped").await);
    assert_eq!(
        bridge
            .post("/api/guest/100/power", json!({ "action": "start" }), Some(&cookie))
            .await
            .0,
        200
    );
    assert!(status_becomes(&mut feed, 100, "running").await);
}

#[tokio::test]
async fn a_guest_that_moved_is_found_on_its_new_node() {
    let mock = mock_pve::start("127.0.0.1:0").await;
    let bridge = bridge("moved").await;
    let cookie = bridge.set_up(&mock).await;
    let power = |action: &'static str| bridge.post("/api/guest/100/power", json!({ "action": action }), Some(&cookie));

    // No page watches the feed, so where the guest lives is read once, here.
    assert_eq!(power("shutdown").await.0, 200);

    mock.mock.move_to(100, mock_pve::NODES[1]);
    let (status, body, _) = power("start").await;
    assert_eq!(status, 200, "{body}");

    mock.mock.move_to(100, mock_pve::NODES[2]);
    let mut console = bridge.socket("/api/console/100", Some(&cookie)).await.unwrap();
    let Message::Text(note) = next(&mut console).await else {
        panic!("not a note")
    };
    assert_eq!(serde_json::from_str::<Value>(note.as_str()).unwrap()["ready"], true, "{note}");
    until(&mut console, "root@pihole:~# ").await;
}

#[tokio::test]
async fn a_console_carries_typing_up_and_output_down() {
    let mock = mock_pve::start("127.0.0.1:0").await;
    let bridge = bridge("console").await;
    let cookie = bridge.set_up(&mock).await;

    assert_eq!(bridge.socket("/api/console/100", None).await.err(), Some(401));

    // Before any page has watched the feed, the bridge finds the guest itself.
    let mut console = bridge.socket("/api/console/100?cols=100&rows=30", Some(&cookie)).await.unwrap();
    let Message::Text(note) = next(&mut console).await else {
        panic!("not a note")
    };
    assert_eq!(serde_json::from_str::<Value>(note.as_str()).unwrap()["ready"], true);
    until(&mut console, "root@pihole:~# ").await;

    console.send(Message::binary(b"echo caf\xc3\xa9\r".to_vec())).await.unwrap();
    let printed = until(&mut console, "\r\ncafé\r\n").await;
    assert!(printed.starts_with("echo café"), "{printed:?}");

    // The size it was opened at, then a new one.
    console.send(Message::binary(b"stty size\r".to_vec())).await.unwrap();
    until(&mut console, "30 100\r\n").await;
    console.send(Message::text(r#"{"resize":[80,25]}"#)).await.unwrap();
    console.send(Message::binary(b"stty size\r".to_vec())).await.unwrap();
    until(&mut console, "25 80\r\n").await;

    // A guest on another node of the cluster is reached through that node.
    let mut other = bridge.socket("/api/console/101", Some(&cookie)).await.unwrap();
    next(&mut other).await;
    until(&mut other, "root@nginx-proxy:~# ").await;

    // When the guest hangs up, the page is told.
    console.send(Message::binary(b"exit\r".to_vec())).await.unwrap();
    let closed = loop {
        match next(&mut console).await {
            Message::Text(note) => break serde_json::from_str::<Value>(note.as_str()).unwrap(),
            Message::Binary(_) => {}
            other => panic!("{other:?}"),
        }
    };
    assert!(closed["closed"].is_string(), "{closed}");

    // A VM without a serial port has no terminal, and says why.
    let mut none = bridge.socket("/api/console/900", Some(&cookie)).await.unwrap();
    let Message::Text(note) = next(&mut none).await else {
        panic!("not a note")
    };
    let note: Value = serde_json::from_str(note.as_str()).unwrap();
    assert!(note["error"].as_str().unwrap().contains("serial interface"), "{note}");

    let mut missing = bridge.socket("/api/console/4242", Some(&cookie)).await.unwrap();
    let Message::Text(note) = next(&mut missing).await else {
        panic!("not a note")
    };
    assert!(note.as_str().contains("no guest 4242"), "{note}");
}

#[tokio::test]
async fn the_page_is_served_with_its_guard_headers() {
    let bridge = bridge("static").await;
    let response = bridge.http.get(format!("http://{}/", bridge.addr)).send().await.unwrap();
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(response.headers()["x-frame-options"], "DENY");
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    assert!(response.text().await.unwrap().contains("proxmox-crt"));
    let escape = bridge
        .http
        .get(format!("http://{}/..%2fconfig.toml", bridge.addr))
        .send()
        .await
        .unwrap();
    assert_eq!(escape.status().as_u16(), 404);
}
