//! The bridge between the page and Proxmox VE. The page cannot talk to
//! Proxmox itself: the API allows no other origin, signs its own certificate,
//! and a browser's websocket cannot carry the token. So the bridge serves the
//! page, keeps the token, and passes on only what the page needs: readings of
//! the cluster and the selected guest's terminal.

// A refusal is passed along as the answer to send, which is large for an
// error and none the worse for it.
#![allow(clippy::result_large_err)]

pub mod auth;
pub mod config;
mod oidc;
mod passkey;
pub mod pve;
mod second_factor;
pub mod totp;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path as UrlPath, Query, State};
use axum::http::header::{CACHE_CONTROL, COOKIE, HOST, ORIGIN, SET_COOKIE};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{AppendHeaders, IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use tokio::sync::{Notify, Semaphore, watch};
use tokio_tungstenite::tungstenite::Message as Upstream;
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;

pub struct Options {
    /// The settings file. It need not exist yet.
    pub config: PathBuf,
    /// The built page (`dist/`).
    pub client: PathBuf,
}

pub struct App {
    config_path: PathBuf,
    config: RwLock<config::Config>,
    pve: RwLock<Option<Arc<pve::Client>>>,
    sessions: auth::Sessions,
    /// Authenticator secrets handed out and not confirmed yet, by the
    /// session that asked. They are saved only once a code proves the app
    /// has them.
    enrolling: Mutex<HashMap<String, second_factor::Enrolling>>,
    /// Passkey challenges that are out and not answered yet.
    passkeys: passkey::Ceremonies,
    /// Sign-ins that are away at the single sign-on provider.
    oidc: oidc::SignIns,
    /// Checking a password takes a while and some memory on purpose, so
    /// only this many are checked at a time and the rest wait their turn.
    hashing: Semaphore,
    /// Proves that whoever fills in the setup card can also read the
    /// bridge's log, so is the one who installed it.
    setup_code: String,
    /// The newest message for the page: a reading, or why there is none.
    feed: watch::Sender<Arc<str>>,
    /// Where each guest of the newest reading lives.
    guests: RwLock<Vec<pve::Guest>>,
    wake: Notify,
}

impl App {
    pub fn new(options: &Options) -> std::io::Result<Arc<App>> {
        let config = config::Config::load(&options.config)?;
        let pve = match &config.proxmox {
            Some(settings) => Some(Arc::new(
                pve::Client::new(settings).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.0))?,
            )),
            None => None,
        };
        if let Some(secret) = &config.second_factor.totp_secret
            && totp::decode_secret(secret).is_none()
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "second_factor.totp_secret is not base32; correct it, or remove it with --reset-second-factor",
            ));
        }
        if !passkey::readable(&config) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "a passkey under second_factor.passkeys cannot be read; remove it, or all of them with --reset-second-factor",
            ));
        }
        let oidc = oidc::SignIns::new(&config).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let code = totp::random_plain(8);
        Ok(Arc::new(App {
            config_path: options.config.clone(),
            config: RwLock::new(config),
            pve: RwLock::new(pve),
            sessions: auth::Sessions::new(),
            enrolling: Mutex::new(HashMap::new()),
            passkeys: passkey::Ceremonies::default(),
            oidc,
            hashing: Semaphore::new(2),
            setup_code: format!("{}-{}", &code[..4], &code[4..]),
            feed: watch::channel(Arc::from("")).0,
            guests: RwLock::new(Vec::new()),
            wake: Notify::new(),
        }))
    }

    pub fn configured(&self) -> bool {
        self.config.read().unwrap().configured()
    }

    pub fn listen(&self) -> String {
        self.config.read().unwrap().listen.clone()
    }

    pub fn setup_code(&self) -> &str {
        &self.setup_code
    }

    fn client(&self) -> Option<Arc<pve::Client>> {
        self.pve.read().unwrap().clone()
    }

    fn authed(&self, headers: &HeaderMap) -> bool {
        self.session(headers).is_some()
    }

    /// The token of the session a request belongs to, if it has one.
    fn session(&self, headers: &HeaderMap) -> Option<String> {
        let cookies = headers.get(COOKIE).and_then(|v| v.to_str().ok());
        auth::cookie_token(cookies).filter(|t| self.sessions.valid(t)).map(str::to_string)
    }

    /// The token of someone who gave the password and owes the second step.
    fn pending(&self, headers: &HeaderMap) -> Option<String> {
        let cookies = headers.get(COOKIE).and_then(|v| v.to_str().ok());
        auth::cookie_value(cookies, auth::PENDING_COOKIE)
            .filter(|t| self.sessions.pending_valid(t))
            .map(str::to_string)
    }

    /// Whether the cookies are to travel over https only.
    fn secure(&self) -> bool {
        self.config.read().unwrap().https()
    }

    /// Opens a session and answers with its cookie. Whatever admitted to a
    /// second step has done its work and is cleared.
    fn let_in(&self) -> Response {
        let token = self.sessions.open();
        let secure = self.secure();
        (
            StatusCode::OK,
            AppendHeaders([
                (SET_COOKIE, auth::set_cookie(Some(&token), secure)),
                (SET_COOKIE, auth::set_pending_cookie(None, secure)),
                (CACHE_CONTROL, "no-store".into()),
            ]),
            Json(json!({ "ok": true })),
        )
            .into_response()
    }

    /// Changes the settings and writes them. The change is made to what
    /// the file says now, not to what it said when the bridge started, so
    /// that what was written into it by hand since, or taken out of it by
    /// `--reset-second-factor` or `--enable-password-login`, is not undone.
    /// Of the result the bridge takes over what it writes itself: the
    /// password, the Proxmox host and the second factors. The rest it goes
    /// by as it was at the start, until it is started again. Nothing is
    /// written, or taken over, if `change` refuses.
    fn change<T>(&self, change: impl FnOnce(&mut config::Config) -> Result<T, Response>) -> Result<T, Response> {
        let mut config = self.config.write().unwrap();
        let failed = |doing: &str, e: std::io::Error| {
            // The reason goes to the log only. A file that does not parse
            // is quoted in its error, line and all, and that line may be
            // the API token or another secret; and whoever is asking may
            // have the password but nothing else.
            eprintln!("settings: could not {doing} {}: {e}", self.config_path.display());
            refuse(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Could not {doing} the settings file. The bridge's log says why."),
            )
        };
        let mut next = config::Config::load(&self.config_path).map_err(|e| failed("read", e))?;
        // What the file says of the second factors holds from here on,
        // whatever becomes of the change.
        config.second_factor = next.second_factor.clone();
        let done = change(&mut next)?;
        next.save(&self.config_path).map_err(|e| failed("write", e))?;
        config.second_factor = next.second_factor;
        config.password_hash = next.password_hash;
        config.proxmox = next.proxmox;
        Ok(done)
    }

    /// What is asked for after the password, as the settings file has it
    /// now: the second factors can be taken out of it from outside, by
    /// `--reset-second-factor`, while the bridge runs. A file that cannot
    /// be read leaves things as they were.
    fn second_factor(&self) -> config::SecondFactor {
        let mut config = self.config.write().unwrap();
        match config::Config::load(&self.config_path) {
            Ok(now) => config.second_factor = now.second_factor,
            Err(e) => eprintln!("settings: could not read {}: {e}", self.config_path.display()),
        }
        config.second_factor.clone()
    }

    /// Checks the password, counting the guess against `from` before it is
    /// looked at and uncounting it if right.
    async fn check_password(&self, from: IpAddr, password: String) -> Result<(), Response> {
        let Some(hash) = self.config.read().unwrap().password_hash.clone() else {
            return Err(refuse(StatusCode::CONFLICT, "This bridge is not set up yet."));
        };
        if !self.sessions.may_guess(from) {
            return Err(refuse(StatusCode::TOO_MANY_REQUESTS, "Too many wrong tries. Wait a minute."));
        }
        let right = {
            let _turn = self.hashing.acquire().await;
            tokio::task::spawn_blocking(move || auth::verify_password(&password, &hash))
                .await
                .unwrap_or(false)
        };
        if !right {
            return Err(refuse(StatusCode::FORBIDDEN, "Wrong password."));
        }
        self.sessions.guessed_right(from);
        Ok(())
    }
}

/// Removes every second factor from the settings file, for an owner who
/// lost them all. Says whether there was any. A bridge that is running
/// reads them from the file again at the next log-in; a restart also closes
/// the sessions that are open.
pub fn reset_second_factor(path: &Path) -> std::io::Result<bool> {
    if !path.exists() {
        return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "there is no such file"));
    }
    let mut config = config::Config::load(path)?;
    if config.second_factor.is_empty() {
        return Ok(false);
    }
    config.second_factor = config::SecondFactor::default();
    config.save(path)?;
    Ok(true)
}

/// Lets the password log in again where the single sign-on settings had
/// turned it off, for an owner the provider no longer lets through. Says
/// whether it was off. A bridge that is running goes on as it was started
/// until it is restarted, and leaves this as it finds it when it writes
/// the file.
pub fn enable_password_login(path: &Path) -> std::io::Result<bool> {
    if !path.exists() {
        return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "there is no such file"));
    }
    let mut config = config::Config::load(path)?;
    if config.password_login() {
        return Ok(false);
    }
    if let Some(oidc) = &mut config.oidc {
        oidc.password_login = true;
    }
    config.save(path)?;
    Ok(true)
}

/// Reads the cluster for as long as a page is watching, and says so when it
/// cannot.
pub async fn poll(app: Arc<App>) {
    loop {
        let every = Duration::from_secs(app.config.read().unwrap().poll_secs.clamp(1, 60));
        let client = app.client();
        match client {
            Some(client) if app.feed.receiver_count() > 0 => {
                let message = match client.read().await {
                    Ok(reading) => {
                        *app.guests.write().unwrap() = reading.guests;
                        json!({ "snapshot": reading.snapshot })
                    }
                    Err(e) => json!({ "error": e.0 }),
                };
                app.feed.send_replace(Arc::from(message.to_string()));
            }
            _ => {}
        }
        tokio::select! {
            _ = tokio::time::sleep(every) => {}
            _ = app.wake.notified() => {}
        }
    }
}

/// The routes. Logging in, setting up and changing how to log in count
/// guesses by the address they come from, so this has to be served the way
/// `serve` does, with `into_make_service_with_connect_info::<SocketAddr>()`.
pub fn router(app: Arc<App>, client_dir: PathBuf) -> Router {
    let header = |name: &'static str, value: &'static str| {
        SetResponseHeaderLayer::if_not_present(HeaderName::from_static(name), HeaderValue::from_static(value))
    };
    Router::new()
        .route("/api/state", get(state))
        .route("/api/setup", post(setup))
        .route("/api/login", post(login))
        .route("/api/login/totp", post(second_factor::login_totp))
        .route("/api/login/passkey/start", post(passkey::login_start))
        .route("/api/login/passkey/finish", post(passkey::login_finish))
        .route("/api/oidc/start", get(oidc::start))
        .route("/api/oidc/callback", get(oidc::callback))
        .route("/api/second-factor", get(second_factor::enrolled))
        .route("/api/second-factor/totp/start", post(second_factor::totp_start))
        .route("/api/second-factor/totp/confirm", post(second_factor::totp_confirm))
        .route("/api/second-factor/totp", delete(second_factor::totp_remove))
        .route("/api/second-factor/recovery", post(second_factor::recovery_renew))
        .route("/api/second-factor/passkey/start", post(passkey::add_start))
        .route("/api/second-factor/passkey/finish", post(passkey::add_finish))
        .route("/api/second-factor/passkey/{id}", delete(passkey::remove))
        .route("/api/logout", post(logout))
        .route("/api/feed", get(feed))
        .route("/api/console/{vmid}", get(console))
        .route("/api/guest/{vmid}/power", post(power))
        .fallback_service(ServeDir::new(client_dir))
        .layer(header("x-content-type-options", "nosniff"))
        .layer(header("x-frame-options", "DENY"))
        .layer(header("referrer-policy", "no-referrer"))
        .with_state(app)
}

/// Serves until the process is told to stop.
pub async fn serve(app: Arc<App>, client_dir: PathBuf, listener: tokio::net::TcpListener) -> std::io::Result<()> {
    tokio::spawn(poll(app.clone()));
    let routes = router(app, client_dir).into_make_service_with_connect_info::<SocketAddr>();
    axum::serve(listener, routes).with_graceful_shutdown(stop_signal()).await
}

async fn stop_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = signal(SignalKind::terminate()).expect("can listen for SIGTERM");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// Said at the second step to whoever has no leave for it, or no longer.
const PASSWORD_AGAIN: &str = "That took too long. Enter the password again.";

fn reply(status: StatusCode, body: Value) -> Response {
    (status, [(CACHE_CONTROL, "no-store")], Json(body)).into_response()
}

fn refuse(status: StatusCode, message: impl Into<String>) -> Response {
    reply(status, json!({ "error": message.into() }))
}

/// A page on another site can make this browser send requests here, cookie
/// and all. When the browser says where a request came from, it has to be
/// this page.
fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(ORIGIN).and_then(|v| v.to_str().ok()) else {
        return true;
    };
    let host = headers.get(HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
    origin.split_once("://").is_some_and(|(_, from)| from.eq_ignore_ascii_case(host))
}

/// What the page is told before anyone has logged in: which ways in to
/// offer, and nothing of what is asked after the password. `https_only`
/// says that the cookies travel over https alone, so that a page opened
/// over plain http can say so in place of taking a password to no end.
async fn state(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    let (password_login, oidc) = {
        let config = app.config.read().unwrap();
        let oidc = config.oidc.as_ref().map(|oidc| json!({ "label": oidc.label }));
        (config.password_login(), oidc)
    };
    reply(
        StatusCode::OK,
        json!({
            "configured": app.configured(),
            "authed": app.authed(&headers),
            "version": env!("CARGO_PKG_VERSION"),
            "password_login": password_login,
            "oidc": oidc,
            "https_only": app.secure(),
        }),
    )
}

#[derive(Deserialize)]
struct Setup {
    code: String,
    url: String,
    token_id: String,
    token_secret: String,
    password: String,
    /// The fingerprint the card showed and its user confirmed.
    #[serde(default)]
    fingerprint: Option<String>,
}

async fn setup(
    State(app): State<Arc<App>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(form): Json<Setup>,
) -> Response {
    if !same_origin(&headers) {
        return refuse(StatusCode::FORBIDDEN, "That request came from another site.");
    }
    if app.configured() {
        return refuse(
            StatusCode::CONFLICT,
            "This bridge is already set up. To start over, delete its settings file and restart it.",
        );
    }
    if !app.sessions.may_guess(from.ip()) {
        return refuse(StatusCode::TOO_MANY_REQUESTS, "Too many wrong tries. Wait a minute.");
    }
    let typed: String = form.code.trim().to_ascii_uppercase();
    if !auth::same(&typed, &app.setup_code) {
        return refuse(
            StatusCode::FORBIDDEN,
            "That is not the setup code. It is in the bridge's log: journalctl -u proxmox-crt",
        );
    }
    app.sessions.guessed_right(from.ip());
    if form.password.chars().count() < auth::MIN_PASSWORD {
        return refuse(
            StatusCode::BAD_REQUEST,
            format!("The password needs at least {} characters.", auth::MIN_PASSWORD),
        );
    }
    if !form.token_id.contains('!') || !form.token_id.contains('@') {
        return refuse(
            StatusCode::BAD_REQUEST,
            "The token ID looks like user@realm!name, for example crt@pve!wall.",
        );
    }
    let base = match pve::base_url(&form.url) {
        Ok(base) => base,
        Err(e) => return refuse(StatusCode::BAD_REQUEST, e.0),
    };

    // A host that signs its own certificate is trusted only once the card's
    // user has seen the fingerprint and sent it back.
    let fingerprint = match form.fingerprint.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
        Some(print) => Some(print.to_string()),
        None => match pve::probe(&base).await {
            Ok(pve::Probe::Public) => None,
            Ok(pve::Probe::SelfSigned(print)) => {
                return reply(StatusCode::OK, json!({ "confirm_fingerprint": print, "url": base }));
            }
            Err(e) => return refuse(StatusCode::BAD_GATEWAY, e.0),
        },
    };

    let settings = config::Proxmox {
        url: base,
        token_id: form.token_id.trim().to_string(),
        token_secret: form.token_secret.trim().to_string(),
        fingerprint,
    };
    let client = match pve::Client::new(&settings) {
        Ok(client) => client,
        Err(e) => return refuse(StatusCode::BAD_REQUEST, e.0),
    };
    let version = match client.version().await {
        Ok(version) => version,
        Err(e) => return refuse(StatusCode::BAD_GATEWAY, e.0),
    };
    let guests = match client.read().await {
        Ok(reading) => reading.guests.len(),
        Err(e) => return refuse(StatusCode::BAD_GATEWAY, e.0),
    };

    let password = form.password;
    let hash = {
        let _turn = app.hashing.acquire().await;
        match tokio::task::spawn_blocking(move || auth::hash_password(&password)).await {
            Ok(Ok(hash)) => hash,
            _ => return refuse(StatusCode::INTERNAL_SERVER_ERROR, "Could not hash the password."),
        }
    };
    let saved = app.change(|config| {
        // Two cards racing: the first one in wins.
        if config.configured() {
            return Err(refuse(StatusCode::CONFLICT, "This bridge is already set up."));
        }
        config.password_hash = Some(hash);
        config.proxmox = Some(settings);
        Ok(())
    });
    if let Err(no) = saved {
        return no;
    }
    *app.pve.write().unwrap() = Some(Arc::new(client));
    app.wake.notify_one();
    let token = app.sessions.open();
    (
        StatusCode::OK,
        [
            (SET_COOKIE, auth::set_cookie(Some(&token), app.secure())),
            (CACHE_CONTROL, "no-store".into()),
        ],
        Json(json!({ "ok": true, "version": version, "guests": guests })),
    )
        .into_response()
}

#[derive(Deserialize)]
struct Login {
    password: String,
}

async fn login(
    State(app): State<Arc<App>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(form): Json<Login>,
) -> Response {
    if !same_origin(&headers) {
        return refuse(StatusCode::FORBIDDEN, "That request came from another site.");
    }
    if !app.config.read().unwrap().password_login() {
        return refuse(
            StatusCode::FORBIDDEN,
            "Logging in by password is turned off here. Use single sign-on.",
        );
    }
    if let Err(no) = app.check_password(from.ip(), form.password).await {
        return no;
    }
    let factor = app.second_factor();
    if !factor.enrolled() {
        return app.let_in();
    }
    // The password was right, and is half of what is asked: no session
    // yet, only leave to go on to the second step.
    let pending = app.sessions.open_pending();
    (
        StatusCode::OK,
        [
            (SET_COOKIE, auth::set_pending_cookie(Some(&pending), app.secure())),
            (CACHE_CONTROL, "no-store".into()),
        ],
        Json(json!({
            "ok": true,
            "second_factor": { "totp": factor.totp_secret.is_some(), "passkey": !factor.passkeys.is_empty() },
        })),
    )
        .into_response()
}

async fn logout(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    if !same_origin(&headers) {
        return refuse(StatusCode::FORBIDDEN, "That request came from another site.");
    }
    let cookies = headers.get(COOKIE).and_then(|v| v.to_str().ok());
    if let Some(token) = auth::cookie_token(cookies) {
        app.sessions.close(token);
        app.enrolling.lock().unwrap().remove(token);
        app.passkeys.forget(token);
    }
    if let Some(token) = auth::cookie_value(cookies, auth::PENDING_COOKIE) {
        app.sessions.close_pending(token);
        app.passkeys.forget(token);
    }
    let secure = app.secure();
    (
        StatusCode::OK,
        AppendHeaders([
            (SET_COOKIE, auth::set_cookie(None, secure)),
            (SET_COOKIE, auth::set_pending_cookie(None, secure)),
        ]),
        Json(json!({ "ok": true })),
    )
        .into_response()
}

/// What a websocket, or anything else that is for the owner only, has to
/// pass.
fn admit(app: &App, headers: &HeaderMap) -> Result<(), Response> {
    if !same_origin(headers) {
        return Err(refuse(StatusCode::FORBIDDEN, "That request came from another site."));
    }
    if !app.authed(headers) {
        return Err(refuse(StatusCode::UNAUTHORIZED, "Log in first."));
    }
    Ok(())
}

async fn feed(State(app): State<Arc<App>>, headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
    if let Err(no) = admit(&app, &headers) {
        return no;
    }
    let Some(session) = app.session(&headers) else {
        return refuse(StatusCode::UNAUTHORIZED, "Log in first.");
    };
    ws.on_upgrade(move |socket| watch_feed(socket, app, session))
}

async fn watch_feed(mut socket: WebSocket, app: Arc<App>, session: String) {
    let mut closings = app.sessions.closings();
    let mut readings = app.feed.subscribe();
    // The reading on hand may be from when a page last watched: ask for a
    // new one rather than show that.
    readings.mark_unchanged();
    app.wake.notify_one();
    loop {
        tokio::select! {
            changed = readings.changed() => {
                if changed.is_err() {
                    break;
                }
                let text = readings.borrow_and_update().to_string();
                if socket.send(Message::Text(text.into())).await.is_err() {
                    break;
                }
            }
            incoming = socket.recv() => {
                // The page sends nothing; this is how its leaving is noticed.
                match incoming {
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => {}
                }
            }
            _ = closings.changed() => {
                // A session that was closed takes its sockets with it.
                if !app.sessions.valid(&session) {
                    break;
                }
            }
        }
    }
    let _ = socket.send(Message::Close(None)).await;
}

#[derive(Deserialize)]
struct Size {
    #[serde(default)]
    cols: Option<u16>,
    #[serde(default)]
    rows: Option<u16>,
}

/// Where a guest lives, from the last reading or, failing that, a new one.
async fn find_guest(app: &App, client: &pve::Client, vmid: u64) -> Option<pve::Guest> {
    let known = app.guests.read().unwrap().iter().find(|g| g.vmid == vmid).cloned();
    if known.is_some() {
        return known;
    }
    // Nothing was read yet, or the guest is newer than the last reading.
    let reading = client.read().await.ok()?;
    let found = reading.guests.iter().find(|g| g.vmid == vmid).cloned();
    *app.guests.write().unwrap() = reading.guests;
    found
}

/// After Proxmox refused something for `guest`: reads the cluster again
/// and, if the guest has moved to another node or its number now belongs
/// to the other kind of guest, says where it is, so it can be tried there.
async fn moved(app: &App, client: &pve::Client, guest: &pve::Guest) -> Option<pve::Guest> {
    let reading = client.read().await.ok()?;
    let found = reading.guests.iter().find(|g| g.vmid == guest.vmid).cloned();
    *app.guests.write().unwrap() = reading.guests;
    found.filter(|now| now != guest)
}

#[derive(Deserialize)]
struct Power {
    action: String,
}

/// Starts a guest, shuts it down or cuts its power. The feed is read again
/// straight away and once more a little later, so the wall shows the change
/// without waiting for its turn.
async fn power(State(app): State<Arc<App>>, headers: HeaderMap, UrlPath(vmid): UrlPath<u64>, Json(form): Json<Power>) -> Response {
    if let Err(no) = admit(&app, &headers) {
        return no;
    }
    if !pve::POWER_ACTIONS.contains(&form.action.as_str()) {
        return refuse(StatusCode::BAD_REQUEST, "The action is start, shutdown or stop.");
    }
    let Some(client) = app.client() else {
        return refuse(StatusCode::CONFLICT, "This bridge is not set up yet.");
    };
    let Some(guest) = find_guest(&app, &client, vmid).await else {
        return refuse(StatusCode::NOT_FOUND, format!("There is no guest {vmid}."));
    };
    let mut switched = client.power(&guest, &form.action).await;
    if switched.is_err()
        && let Some(guest) = moved(&app, &client, &guest).await
    {
        switched = client.power(&guest, &form.action).await;
    }
    if let Err(e) = switched {
        return refuse(StatusCode::BAD_GATEWAY, e.0);
    }
    app.wake.notify_one();
    let later = app.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(2)).await;
        later.wake.notify_one();
    });
    reply(StatusCode::OK, json!({ "ok": true }))
}

async fn console(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    UrlPath(vmid): UrlPath<u64>,
    Query(size): Query<Size>,
    ws: WebSocketUpgrade,
) -> Response {
    if let Err(no) = admit(&app, &headers) {
        return no;
    }
    let Some(session) = app.session(&headers) else {
        return refuse(StatusCode::UNAUTHORIZED, "Log in first.");
    };
    let cols = size.cols.unwrap_or(80).clamp(20, 300);
    let rows = size.rows.unwrap_or(25).clamp(5, 120);
    ws.on_upgrade(move |socket| run_console(socket, app, session, vmid, cols, rows))
}

async fn tell(socket: &mut WebSocket, message: Value) {
    let _ = socket.send(Message::Text(message.to_string().into())).await;
}

/// Finds the guest, opens its terminal on Proxmox, and carries bytes both
/// ways until either side hangs up. To the page: binary is what the guest
/// printed, text is a note about the console itself. From the page: binary
/// is what was typed, text a change of size.
async fn run_console(mut socket: WebSocket, app: Arc<App>, session: String, vmid: u64, cols: u16, rows: u16) {
    let mut closings = app.sessions.closings();
    let Some(client) = app.client() else {
        return tell(&mut socket, json!({ "error": "The bridge is not set up yet." })).await;
    };
    let Some(guest) = find_guest(&app, &client, vmid).await else {
        return tell(&mut socket, json!({ "error": format!("There is no guest {vmid}.") })).await;
    };
    let mut opened = client.console(&guest).await;
    if opened.is_err()
        && let Some(guest) = moved(&app, &client, &guest).await
    {
        opened = client.console(&guest).await;
    }
    let opened = match opened {
        Ok(opened) => opened,
        Err(e) => return tell(&mut socket, json!({ "error": e.0 })).await,
    };
    let (mut up_tx, mut up_rx) = opened.stream.split();
    if up_tx.send(Upstream::binary(pve::frame_resize(cols, rows))).await.is_err() {
        return tell(&mut socket, json!({ "error": "The console closed as it opened." })).await;
    }
    tell(&mut socket, json!({ "ready": true })).await;
    if !opened.early.is_empty() && socket.send(Message::Binary(opened.early.into())).await.is_err() {
        return;
    }

    let mut ping = tokio::time::interval(Duration::from_secs(30));
    ping.tick().await;
    let why = loop {
        tokio::select! {
            from_page = socket.recv() => match from_page {
                Some(Ok(Message::Binary(typed))) => {
                    if up_tx.send(Upstream::binary(pve::frame_input(&typed))).await.is_err() {
                        break Some("The console closed.");
                    }
                }
                Some(Ok(Message::Text(note))) => {
                    let size = serde_json::from_str::<Value>(note.as_str()).ok().and_then(|v| {
                        let size = v.get("resize")?.as_array()?;
                        Some((size.first()?.as_u64()?, size.get(1)?.as_u64()?))
                    });
                    if let Some((c, r)) = size {
                        let frame = pve::frame_resize(c.clamp(20, 300) as u16, r.clamp(5, 120) as u16);
                        if up_tx.send(Upstream::binary(frame)).await.is_err() {
                            break Some("The console closed.");
                        }
                    }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break None,
                Some(Ok(_)) => {}
            },
            from_guest = up_rx.next() => match from_guest {
                Some(Ok(Upstream::Binary(printed))) => {
                    if socket.send(Message::Binary(printed)).await.is_err() {
                        break None;
                    }
                }
                Some(Ok(Upstream::Text(printed))) => {
                    if socket.send(Message::Binary(printed.as_bytes().to_vec().into())).await.is_err() {
                        break None;
                    }
                }
                Some(Ok(Upstream::Close(_))) | Some(Err(_)) | None => break Some("The console closed."),
                Some(Ok(_)) => {}
            },
            _ = ping.tick() => {
                if up_tx.send(Upstream::binary(pve::FRAME_PING)).await.is_err() {
                    break Some("The console closed.");
                }
            }
            _ = closings.changed() => {
                if !app.sessions.valid(&session) {
                    break Some("The session was closed.");
                }
            }
        }
    };
    let _ = up_tx.close().await;
    if let Some(why) = why {
        tell(&mut socket, json!({ "closed": why })).await;
    }
    let _ = socket.send(Message::Close(None)).await;
}
