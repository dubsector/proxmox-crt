//! A stand-in for a Proxmox VE host, for developing and testing the bridge
//! without one. It speaks the few parts of the API the bridge uses, the way
//! Proxmox does: https with a certificate it signed itself, an API token in
//! the Authorization header, and the terminal proxy's ticket and framing.
//! Every guest's console is a toy shell.
//!
//!     cargo run --example mock_pve -- --listen 127.0.0.1:8006
//!
//! It prints the token and the certificate fingerprint to give the bridge.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub const TOKEN_ID: &str = "crt@pve!wall";
pub const TOKEN_SECRET: &str = "00000000-0000-4000-8000-000000000000";
pub const NODES: [&str; 3] = ["pve1", "pve2", "pve3"];

const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

const NAMES: [&str; 46] = [
    "pihole",
    "nginx-proxy",
    "homeassistant",
    "jellyfin",
    "sonarr",
    "radarr",
    "prowlarr",
    "qbittorrent",
    "grafana",
    "prometheus",
    "influxdb",
    "vaultwarden",
    "nextcloud",
    "paperless",
    "immich",
    "gitea",
    "postgres",
    "mariadb",
    "redis",
    "mosquitto",
    "zigbee2mqtt",
    "frigate",
    "unifi",
    "wireguard",
    "tailscale",
    "adguard",
    "uptime-kuma",
    "homepage",
    "authentik",
    "traefik",
    "minio",
    "syncthing",
    "matomo",
    "minecraft",
    "velocity",
    "plantit-queue",
    "meraki-emulator",
    "loki",
    "alloy",
    "ntfy",
    "changedetect",
    "mealie",
    "actual",
    "stirling-pdf",
    "docker-host",
    "build-runner",
];

struct Guest {
    vmid: u64,
    name: String,
    kind: &'static str,
    node: &'static str,
    running: bool,
    cores: u64,
    maxmem: f64,
    /// A VM without a serial port has no terminal to proxy.
    serial: bool,
}

pub struct Mock {
    guests: Mutex<Vec<Guest>>,
    tickets: Mutex<HashMap<u64, String>>,
    started: Instant,
}

/// A running mock: where it listens and the fingerprint of its certificate.
pub struct Running {
    pub addr: SocketAddr,
    pub fingerprint: String,
    pub mock: Arc<Mock>,
}

impl Mock {
    fn new() -> Mock {
        let mut guests: Vec<Guest> = NAMES
            .iter()
            .enumerate()
            .map(|(i, name)| Guest {
                vmid: 100 + i as u64,
                name: name.to_string(),
                kind: "lxc",
                node: NODES[i % NODES.len()],
                running: i < NAMES.len() - 3,
                cores: [1, 2, 2, 4][i % 4],
                maxmem: [0.5, 1.0, 2.0, 4.0][(i / 2) % 4] * GIB,
                serial: true,
            })
            .collect();
        guests.push(Guest {
            vmid: 900,
            name: "win11-lab".into(),
            kind: "qemu",
            node: NODES[0],
            running: true,
            cores: 4,
            maxmem: 8.0 * GIB,
            serial: false,
        });
        guests.push(Guest {
            vmid: 901,
            name: "truenas".into(),
            kind: "qemu",
            node: NODES[1],
            running: true,
            cores: 4,
            maxmem: 8.0 * GIB,
            serial: true,
        });
        Mock {
            guests: Mutex::new(guests),
            tickets: Mutex::new(HashMap::new()),
            started: Instant::now(),
        }
    }

    /// Starts or stops a guest, as a test's hand on the host.
    pub fn set_running(&self, vmid: u64, running: bool) {
        for g in self.guests.lock().unwrap().iter_mut() {
            if g.vmid == vmid {
                g.running = running;
            }
        }
    }
}

/// Serves the mock on `addr` (port 0 picks a free one) until dropped with
/// the runtime.
pub async fn start(addr: &str) -> Running {
    let key = rcgen::generate_simple_self_signed(vec!["localhost".to_string(), "127.0.0.1".to_string()]).expect("a certificate");
    let der = key.cert.der().to_vec();
    let fingerprint = proxmox_crt::pve::fingerprint(&der);
    let tls = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![rustls::pki_types::CertificateDer::from(der)],
            rustls::pki_types::PrivateKeyDer::try_from(key.signing_key.serialize_der()).unwrap(),
        )
        .unwrap();

    let mock = Arc::new(Mock::new());
    let app = Router::new()
        .route("/api2/json/version", get(version))
        .route("/api2/json/cluster/resources", get(resources))
        .route("/api2/json/nodes/{node}/status", get(node_status))
        .route("/api2/json/nodes/{node}/{kind}/{vmid}/termproxy", post(termproxy))
        .route("/api2/json/nodes/{node}/{kind}/{vmid}/vncwebsocket", get(vncwebsocket))
        .route("/api2/json/nodes/{node}/{kind}/{vmid}/status/{action}", post(power))
        .with_state(mock.clone());

    let listener = std::net::TcpListener::bind(addr).expect("a port to listen on");
    let addr = listener.local_addr().unwrap();
    let server =
        axum_server::from_tcp_rustls(listener, axum_server::tls_rustls::RustlsConfig::from_config(Arc::new(tls))).expect("a server");
    tokio::spawn(async move {
        server.serve(app.into_make_service()).await.unwrap();
    });
    Running { addr, fingerprint, mock }
}

fn no(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "data": null, "message": message }))).into_response()
}

#[allow(clippy::result_large_err)]
fn allowed(headers: &HeaderMap) -> Result<(), Response> {
    let want = format!("PVEAPIToken={TOKEN_ID}={TOKEN_SECRET}");
    match headers.get("authorization").and_then(|v| v.to_str().ok()) {
        Some(got) if got == want => Ok(()),
        Some(_) => Err(no(StatusCode::UNAUTHORIZED, "invalid PVE API token")),
        None => Err(no(StatusCode::UNAUTHORIZED, "No ticket")),
    }
}

async fn version(headers: HeaderMap) -> Response {
    if let Err(r) = allowed(&headers) {
        return r;
    }
    Json(json!({ "data": { "version": "9.0.3", "release": "9.0", "repoid": "mock" } })).into_response()
}

/// A load that wanders with time, differently for each guest.
fn wander(seed: u64, t: f64) -> f64 {
    let s = seed as f64;
    (0.5 + 0.5 * (t / (7.0 + s % 5.0) + s).sin()) * (0.5 + 0.5 * (t / 31.0 + s * 1.7).cos())
}

async fn resources(State(mock): State<Arc<Mock>>, headers: HeaderMap) -> Response {
    if let Err(r) = allowed(&headers) {
        return r;
    }
    let t = mock.started.elapsed().as_secs_f64();
    let guests = mock.guests.lock().unwrap();
    let mut rows = Vec::new();
    let mut used = [0.0; NODES.len()];
    let mut mem = [6.0 * GIB; NODES.len()];
    for g in guests.iter() {
        let cpu = if g.running {
            0.005 + 0.4 * wander(g.vmid, t) * wander(g.vmid * 3, t)
        } else {
            0.0
        };
        let m = if g.running {
            g.maxmem * (0.3 + 0.4 * wander(g.vmid * 7, t / 5.0))
        } else {
            0.0
        };
        let at = NODES.iter().position(|n| *n == g.node).unwrap_or(0);
        used[at] += cpu * g.cores as f64;
        mem[at] += m;
        let rate = 2e3 + 1e5 * (g.vmid % 9) as f64;
        rows.push(json!({
            "id": format!("{}/{}", g.kind, g.vmid),
            "type": g.kind,
            "vmid": g.vmid,
            "name": g.name,
            "node": g.node,
            "status": if g.running { "running" } else { "stopped" },
            "template": 0,
            "cpu": cpu,
            "maxcpu": g.cores,
            "mem": m.floor(),
            "maxmem": g.maxmem,
            "disk": if g.kind == "lxc" { 3.0 * GIB } else { 0.0 },
            "maxdisk": 16.0 * GIB,
            "netin": if g.running { (rate * t).floor() } else { 0.0 },
            "netout": if g.running { (rate * 0.4 * t).floor() } else { 0.0 },
            "uptime": if g.running { 86400 * (1 + g.vmid % 30) + t as u64 } else { 0 },
        }));
    }
    // What Proxmox lists besides guests, which the bridge has to step over.
    rows.push(json!({ "id": "lxc/999", "type": "lxc", "vmid": 999, "name": "debian-13-template", "node": NODES[0], "status": "stopped", "template": 1, "maxcpu": 1, "maxmem": GIB, "maxdisk": 4.0 * GIB }));
    rows.push(json!({ "id": "storage/pve/local", "type": "storage", "storage": "local", "node": NODES[0], "status": "available", "disk": 180.0 * GIB, "maxdisk": 480.0 * GIB }));
    for (at, node) in NODES.iter().enumerate() {
        rows.push(json!({
            "id": format!("node/{node}"),
            "type": "node",
            "node": node,
            "status": "online",
            "cpu": (used[at] / 16.0 + 0.02).min(1.0),
            "maxcpu": 16,
            "mem": mem[at].min(64.0 * GIB).floor(),
            "maxmem": 64.0 * GIB,
            "disk": 180.0 * GIB,
            "maxdisk": 480.0 * GIB,
            "uptime": 61 * 86400 + t as u64,
        }));
    }
    Json(json!({ "data": rows })).into_response()
}

async fn node_status(State(mock): State<Arc<Mock>>, headers: HeaderMap, Path(node): Path<String>) -> Response {
    if let Err(r) = allowed(&headers) {
        return r;
    }
    if !NODES.contains(&node.as_str()) {
        return no(StatusCode::INTERNAL_SERVER_ERROR, "no such cluster node");
    }
    let t = mock.started.elapsed().as_secs_f64();
    let load = 0.8 + wander(node.len() as u64 + u64::from(node.as_bytes()[node.len() - 1]), t);
    // Proxmox gives the load averages as strings.
    Json(json!({ "data": { "loadavg": [format!("{load:.2}"), format!("{:.2}", load * 0.9), format!("{:.2}", load * 0.8)], "uptime": 61 * 86400 } })).into_response()
}

async fn termproxy(State(mock): State<Arc<Mock>>, headers: HeaderMap, Path((node, kind, vmid)): Path<(String, String, u64)>) -> Response {
    if let Err(r) = allowed(&headers) {
        return r;
    }
    {
        let guests = mock.guests.lock().unwrap();
        // A guest is reached through the node it is on, and no other.
        let Some(g) = guests.iter().find(|g| g.vmid == vmid && g.kind == kind && g.node == node) else {
            return no(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("Configuration file 'nodes/{node}/{kind}/{vmid}.conf' does not exist"),
            );
        };
        if !g.serial {
            return no(StatusCode::INTERNAL_SERVER_ERROR, "unable to find a serial interface");
        }
    }
    let mut tickets = mock.tickets.lock().unwrap();
    let port = 5900 + tickets.len() as u64;
    // The characters a real ticket has, which have to survive a query string.
    let ticket = format!("PVEVNC:{:08X}::a+b/c{}==", port, vmid);
    tickets.insert(port, ticket.clone());
    Json(json!({ "data": { "port": port, "ticket": ticket, "user": TOKEN_ID, "upid": format!("UPID:{node}:0000:vncproxy:{vmid}:{TOKEN_ID}:") } })).into_response()
}

async fn vncwebsocket(
    State(mock): State<Arc<Mock>>,
    headers: HeaderMap,
    Path((_node, _kind, vmid)): Path<(String, String, u64)>,
    Query(query): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Response {
    if let Err(r) = allowed(&headers) {
        return r;
    }
    let port = query.get("port").and_then(|p| p.parse::<u64>().ok()).unwrap_or(0);
    let ticket = mock.tickets.lock().unwrap().get(&port).cloned();
    if ticket.is_none() || ticket.as_ref() != query.get("vncticket") {
        return no(StatusCode::UNAUTHORIZED, "invalid vncticket");
    }
    let (name, running) = {
        let guests = mock.guests.lock().unwrap();
        match guests.iter().find(|g| g.vmid == vmid) {
            Some(g) => (g.name.clone(), g.running),
            None => return no(StatusCode::INTERNAL_SERVER_ERROR, "no such guest"),
        }
    };
    ws.protocols(["binary"])
        .on_upgrade(move |socket| shell(socket, name, running, ticket.unwrap()))
}

async fn power(
    State(mock): State<Arc<Mock>>,
    headers: HeaderMap,
    Path((node, _kind, vmid, action)): Path<(String, String, u64, String)>,
) -> Response {
    if let Err(r) = allowed(&headers) {
        return r;
    }
    match action.as_str() {
        "start" => mock.set_running(vmid, true),
        "stop" | "shutdown" => mock.set_running(vmid, false),
        "reboot" => {}
        _ => return no(StatusCode::NOT_IMPLEMENTED, "no such action"),
    }
    Json(json!({ "data": format!("UPID:{node}:0000:{action}:{vmid}:{TOKEN_ID}:") })).into_response()
}

async fn say(socket: &mut WebSocket, text: &str) -> bool {
    socket.send(Message::Binary(text.as_bytes().to_vec().into())).await.is_ok()
}

/// The terminal proxy: the ticket once more, OK, then a toy shell behind
/// the proxy's framing (`0:length:bytes` typed, `1:cols:rows:` a new size,
/// `2` a ping).
async fn shell(mut socket: WebSocket, name: String, running: bool, ticket: String) {
    let greeting = match socket.recv().await {
        Some(Ok(Message::Binary(b))) => b.to_vec(),
        Some(Ok(Message::Text(t))) => t.as_bytes().to_vec(),
        _ => return,
    };
    if greeting != format!("{TOKEN_ID}:{ticket}\n").into_bytes() {
        return;
    }
    if !say(&mut socket, "OK").await {
        return;
    }
    if !running {
        say(&mut socket, &format!("CT {name} is not running\r\n")).await;
        return;
    }
    let prompt = format!("root@{name}:~# ");
    let mut size = (80u64, 24u64);
    let mut line = String::new();
    let mut escape = 0;
    if !say(&mut socket, &format!("\r\nDebian GNU/Linux 13 {name} tty1\r\n\r\n{prompt}")).await {
        return;
    }
    while let Some(Ok(message)) = socket.recv().await {
        let frame = match message {
            Message::Binary(b) => b.to_vec(),
            Message::Text(t) => t.as_bytes().to_vec(),
            Message::Close(_) => return,
            _ => continue,
        };
        let mut parts = frame.splitn(3, |b| *b == b':');
        let kind = parts.next().unwrap_or(b"");
        if kind == b"1" {
            let cols = parts.next().and_then(|c| std::str::from_utf8(c).ok()?.parse().ok());
            let rows = parts
                .next()
                .and_then(|r| std::str::from_utf8(r).ok()?.trim_end_matches(':').parse().ok());
            if let (Some(c), Some(r)) = (cols, rows) {
                size = (c, r);
            }
            continue;
        }
        if kind != b"0" {
            continue;
        }
        let length: usize = parts.next().and_then(|l| std::str::from_utf8(l).ok()?.parse().ok()).unwrap_or(0);
        let typed = parts.next().unwrap_or(b"");
        if typed.len() != length {
            continue;
        }
        let mut out = String::new();
        for ch in String::from_utf8_lossy(typed).chars() {
            // An arrow or function key arrives as an escape sequence, which
            // this shell has no use for.
            if escape > 0 {
                escape = match (escape, ch) {
                    (1, '[' | 'O') => 2,
                    (2, c) if !('\u{40}'..='\u{7e}').contains(&c) => 2,
                    _ => 0,
                };
                continue;
            }
            match ch {
                '\u{1b}' => escape = 1,
                '\r' | '\n' => {
                    out.push_str("\r\n");
                    let command = line.trim().to_string();
                    line.clear();
                    match command.as_str() {
                        "" => {}
                        "hostname" => out.push_str(&format!("{name}\r\n")),
                        "whoami" => out.push_str("root\r\n"),
                        "uname -a" => out.push_str(&format!("Linux {name} 6.14.8-2-pve #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux\r\n")),
                        "stty size" => out.push_str(&format!("{} {}\r\n", size.1, size.0)),
                        "clear" => out.push_str("\x1b[H\x1b[2J"),
                        "exit" | "logout" => {
                            out.push_str("logout\r\n");
                            say(&mut socket, &out).await;
                            return;
                        }
                        other => match other.strip_prefix("echo ") {
                            Some(rest) => out.push_str(&format!("{rest}\r\n")),
                            None => out.push_str(&format!("-bash: {}: command not found\r\n", other.split(' ').next().unwrap_or(""))),
                        },
                    }
                    out.push_str(&prompt);
                }
                '\u{7f}' | '\u{8}' => {
                    if line.pop().is_some() {
                        out.push_str("\u{8} \u{8}");
                    }
                }
                '\u{3}' => {
                    line.clear();
                    out.push_str(&format!("^C\r\n{prompt}"));
                }
                '\u{4}' if line.is_empty() => {
                    say(&mut socket, "logout\r\n").await;
                    return;
                }
                c if !c.is_control() => {
                    line.push(c);
                    out.push(c);
                }
                _ => {}
            }
        }
        if !out.is_empty() && !say(&mut socket, &out).await {
            return;
        }
    }
}

#[allow(dead_code)]
#[tokio::main]
async fn main() {
    let mut listen = "127.0.0.1:8006".to_string();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--listen" {
            listen = args.next().expect("--listen needs an address");
        }
    }
    let running = start(&listen).await;
    println!("mock Proxmox VE on https://{}", running.addr);
    println!("  token ID      {TOKEN_ID}");
    println!("  token secret  {TOKEN_SECRET}");
    println!("  fingerprint   {}", running.fingerprint);
    std::future::pending::<()>().await;
}
