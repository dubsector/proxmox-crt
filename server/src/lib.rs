//! The bridge between the page and Proxmox VE. The page cannot talk to
//! Proxmox itself: the API allows no other origin, signs its own certificate,
//! and a browser's websocket cannot carry the token. So the bridge serves the
//! page, keeps the token, and passes on only what the page needs: readings of
//! the cluster and the selected guest's terminal.

pub mod auth;
pub mod config;
pub mod pve;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path as UrlPath, Query, State};
use axum::http::header::{CACHE_CONTROL, COOKIE, HOST, ORIGIN, SET_COOKIE};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::sync::{Notify, watch};
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
        // Letters and digits that are not mistaken for one another.
        let alphabet = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let raw = auth::random_hex(8);
        let code: String = raw
            .as_bytes()
            .chunks(2)
            .map(|pair| {
                let byte = u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap();
                alphabet[usize::from(byte) % alphabet.len()] as char
            })
            .collect();
        Ok(Arc::new(App {
            config_path: options.config.clone(),
            config: RwLock::new(config),
            pve: RwLock::new(pve),
            sessions: auth::Sessions::new(),
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
        let cookies = headers.get(COOKIE).and_then(|v| v.to_str().ok());
        auth::cookie_token(cookies).is_some_and(|t| self.sessions.valid(t))
    }
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

pub fn router(app: Arc<App>, client_dir: PathBuf) -> Router {
    let header = |name: &'static str, value: &'static str| {
        SetResponseHeaderLayer::if_not_present(HeaderName::from_static(name), HeaderValue::from_static(value))
    };
    Router::new()
        .route("/api/state", get(state))
        .route("/api/setup", post(setup))
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/feed", get(feed))
        .route("/api/console/{vmid}", get(console))
        .fallback_service(ServeDir::new(client_dir))
        .layer(header("x-content-type-options", "nosniff"))
        .layer(header("x-frame-options", "DENY"))
        .layer(header("referrer-policy", "no-referrer"))
        .with_state(app)
}

/// Serves until the process is told to stop.
pub async fn serve(app: Arc<App>, client_dir: PathBuf, listener: tokio::net::TcpListener) -> std::io::Result<()> {
    tokio::spawn(poll(app.clone()));
    axum::serve(listener, router(app, client_dir))
        .with_graceful_shutdown(stop_signal())
        .await
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

async fn state(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    reply(
        StatusCode::OK,
        json!({
            "configured": app.configured(),
            "authed": app.authed(&headers),
            "version": env!("CARGO_PKG_VERSION"),
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

async fn setup(State(app): State<Arc<App>>, headers: HeaderMap, Json(form): Json<Setup>) -> Response {
    if !same_origin(&headers) {
        return refuse(StatusCode::FORBIDDEN, "That request came from another site.");
    }
    if app.configured() {
        return refuse(
            StatusCode::CONFLICT,
            "This bridge is already set up. To start over, delete its settings file and restart it.",
        );
    }
    if !app.sessions.may_guess() {
        return refuse(StatusCode::TOO_MANY_REQUESTS, "Too many wrong tries. Wait a minute.");
    }
    let typed: String = form.code.trim().to_ascii_uppercase();
    if !auth::same(&typed, &app.setup_code) {
        app.sessions.guessed_wrong();
        return refuse(
            StatusCode::FORBIDDEN,
            "That is not the setup code. It is in the bridge's log: journalctl -u proxmox-crt",
        );
    }
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
    let hash = match tokio::task::spawn_blocking(move || auth::hash_password(&password)).await {
        Ok(Ok(hash)) => hash,
        _ => return refuse(StatusCode::INTERNAL_SERVER_ERROR, "Could not hash the password."),
    };
    let saved = {
        let mut config = app.config.write().unwrap();
        // Two cards racing: the first one in wins.
        if config.configured() {
            return refuse(StatusCode::CONFLICT, "This bridge is already set up.");
        }
        let mut next = config.clone();
        next.password_hash = Some(hash);
        next.proxmox = Some(settings);
        let saved = next.save(&app.config_path);
        if saved.is_ok() {
            *config = next;
        }
        saved
    };
    if let Err(e) = saved {
        return refuse(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Could not write {}: {e}", app.config_path.display()),
        );
    }
    *app.pve.write().unwrap() = Some(Arc::new(client));
    app.wake.notify_one();
    let token = app.sessions.open();
    (
        StatusCode::OK,
        [(SET_COOKIE, auth::set_cookie(Some(&token))), (CACHE_CONTROL, "no-store".into())],
        Json(json!({ "ok": true, "version": version, "guests": guests })),
    )
        .into_response()
}

#[derive(Deserialize)]
struct Login {
    password: String,
}

async fn login(State(app): State<Arc<App>>, headers: HeaderMap, Json(form): Json<Login>) -> Response {
    if !same_origin(&headers) {
        return refuse(StatusCode::FORBIDDEN, "That request came from another site.");
    }
    let Some(hash) = app.config.read().unwrap().password_hash.clone() else {
        return refuse(StatusCode::CONFLICT, "This bridge is not set up yet.");
    };
    if !app.sessions.may_guess() {
        return refuse(StatusCode::TOO_MANY_REQUESTS, "Too many wrong tries. Wait a minute.");
    }
    let password = form.password;
    let right = tokio::task::spawn_blocking(move || auth::verify_password(&password, &hash))
        .await
        .unwrap_or(false);
    if !right {
        app.sessions.guessed_wrong();
        return refuse(StatusCode::FORBIDDEN, "Wrong password.");
    }
    let token = app.sessions.open();
    (
        StatusCode::OK,
        [(SET_COOKIE, auth::set_cookie(Some(&token))), (CACHE_CONTROL, "no-store".into())],
        Json(json!({ "ok": true })),
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
    }
    (StatusCode::OK, [(SET_COOKIE, auth::set_cookie(None))], Json(json!({ "ok": true }))).into_response()
}

/// What a websocket has to pass before it is opened.
#[allow(clippy::result_large_err)]
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
    ws.on_upgrade(move |socket| watch_feed(socket, app))
}

async fn watch_feed(mut socket: WebSocket, app: Arc<App>) {
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
        }
    }
}

#[derive(Deserialize)]
struct Size {
    #[serde(default)]
    cols: Option<u16>,
    #[serde(default)]
    rows: Option<u16>,
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
    let cols = size.cols.unwrap_or(80).clamp(20, 300);
    let rows = size.rows.unwrap_or(25).clamp(5, 120);
    ws.on_upgrade(move |socket| run_console(socket, app, vmid, cols, rows))
}

async fn tell(socket: &mut WebSocket, message: Value) {
    let _ = socket.send(Message::Text(message.to_string().into())).await;
}

/// Finds the guest, opens its terminal on Proxmox, and carries bytes both
/// ways until either side hangs up. To the page: binary is what the guest
/// printed, text is a note about the console itself. From the page: binary
/// is what was typed, text a change of size.
async fn run_console(mut socket: WebSocket, app: Arc<App>, vmid: u64, cols: u16, rows: u16) {
    let Some(client) = app.client() else {
        return tell(&mut socket, json!({ "error": "The bridge is not set up yet." })).await;
    };
    let mut guest = app.guests.read().unwrap().iter().find(|g| g.vmid == vmid).cloned();
    if guest.is_none() {
        // Nothing was read yet, or the guest is newer than the last reading.
        if let Ok(reading) = client.read().await {
            guest = reading.guests.iter().find(|g| g.vmid == vmid).cloned();
            *app.guests.write().unwrap() = reading.guests;
        }
    }
    let Some(guest) = guest else {
        return tell(&mut socket, json!({ "error": format!("There is no guest {vmid}.") })).await;
    };
    let opened = match client.console(&guest).await {
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
        }
    };
    let _ = up_tx.close().await;
    if let Some(why) = why {
        tell(&mut socket, json!({ "closed": why })).await;
    }
    let _ = socket.send(Message::Close(None)).await;
}
