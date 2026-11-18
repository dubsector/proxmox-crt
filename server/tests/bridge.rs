//! The bridge end to end, against the mock Proxmox host: setting up,
//! logging in, the feed of readings, and typing into a console.

#[path = "../examples/mock_pve.rs"]
mod mock_pve;

use futures_util::{SinkExt, StreamExt};
use proxmox_crt::{App, Options, config, pve};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const PASSWORD: &str = "correct horse";

struct Bridge {
    addr: String,
    app: Arc<App>,
    config: PathBuf,
    http: reqwest::Client,
}

async fn bridge(name: &str) -> Bridge {
    let dir = std::env::temp_dir().join(format!("proxmox-crt-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("client")).unwrap();
    std::fs::write(dir.join("client/index.html"), "<title>proxmox-crt</title>").unwrap();
    let options = Options {
        config: dir.join("config.toml"),
        client: dir.join("client"),
    };
    let app = App::new(&options).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(proxmox_crt::serve(app.clone(), options.client.clone(), listener));
    // The tests' own client speaks plain http, but is built with TLS in it.
    let _ = rustls::crypto::ring::default_provider().install_default();
    Bridge {
        addr,
        app,
        config: options.config,
        http: reqwest::Client::new(),
    }
}

impl Bridge {
    async fn post(&self, path: &str, body: Value, cookie: Option<&str>) -> (u16, Value, Option<String>) {
        let mut request = self.http.post(format!("http://{}{path}", self.addr)).json(&body);
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
        let mut request = self.http.get(format!("http://{}/api/state", self.addr));
        if let Some(cookie) = cookie {
            request = request.header("Cookie", cookie);
        }
        request.send().await.unwrap().json().await.unwrap()
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
