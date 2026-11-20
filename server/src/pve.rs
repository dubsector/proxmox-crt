//! The Proxmox VE side: the REST API with an API token, and the console
//! websocket a guest's terminal comes down.
//!
//! A Proxmox host signs its own certificate unless its owner set up ACME, so
//! the usual chain check would refuse it. Instead of trusting everything,
//! the bridge remembers the certificate's fingerprint from the setup card
//! and accepts only that one.

use crate::config;
use futures_util::{SinkExt, StreamExt};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, WebPkiSupportedAlgorithms};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::{Connector, MaybeTlsStream, WebSocketStream};

const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug)]
pub struct Error(pub String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

fn err(message: impl Into<String>) -> Error {
    Error(message.into())
}

pub type Result<T> = std::result::Result<T, Error>;

/// `AA:BB:...`, the form Proxmox shows under Node, System, Certificates.
pub fn fingerprint(der: &[u8]) -> String {
    Sha256::digest(der).iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

/// The same fingerprint however it was typed: any case, with or without
/// colons or spaces.
pub fn normalise_fingerprint(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_ascii_hexdigit())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// Accepts the one certificate whose fingerprint was pinned. With nothing
/// pinned it accepts any, and notes which it was shown: that is how the
/// setup card learns the fingerprint, and nothing secret is sent that way.
#[derive(Debug)]
struct Pin {
    want: Option<String>,
    seen: Mutex<Option<String>>,
    algorithms: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for Pin {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        let got = fingerprint(end_entity.as_ref());
        match &self.want {
            Some(want) if *want != normalise_fingerprint(&got) => Err(rustls::Error::General(format!(
                "the host's certificate changed: its fingerprint is now {got}"
            ))),
            _ => {
                *self.seen.lock().unwrap() = Some(got);
                Ok(ServerCertVerified::assertion())
            }
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

fn tls_pinned(pin: Arc<Pin>) -> ClientConfig {
    ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .expect("the provider supports the default TLS versions")
        .dangerous()
        .with_custom_certificate_verifier(pin)
        .with_no_client_auth()
}

pub(crate) fn tls_public() -> ClientConfig {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .expect("the provider supports the default TLS versions")
        .with_root_certificates(roots)
        .with_no_client_auth()
}

fn http(tls: ClientConfig) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .timeout(TIMEOUT)
        .connect_timeout(TIMEOUT)
        .build()
        .map_err(|e| err(format!("could not build the HTTP client: {e}")))
}

/// `https://host:8006`, from whatever was typed: a bare host, a host and
/// port, or the address of the web interface.
pub fn base_url(typed: &str) -> Result<String> {
    let t = typed.trim().trim_end_matches('/');
    if t.is_empty() {
        return Err(err("the Proxmox address is empty"));
    }
    let rest = match t.split_once("://") {
        Some(("https", rest)) => rest,
        Some((scheme, _)) => return Err(err(format!("the Proxmox API is https, not {scheme}"))),
        None => t,
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() || host.contains('@') || host.chars().any(char::is_whitespace) {
        return Err(err("that does not look like a host name or address"));
    }
    // An IPv6 address carries colons of its own; its port follows the bracket.
    let has_port = match host.rfind(']') {
        Some(end) => host[end..].contains(':'),
        None => host.contains(':'),
    };
    Ok(if has_port {
        format!("https://{host}")
    } else {
        format!("https://{host}:8006")
    })
}

/// What the setup card needs to know about a host before it trusts it.
#[derive(Debug, PartialEq)]
pub enum Probe {
    /// Its certificate chains to a public authority; no pin needed.
    Public,
    /// It signs its own; this is the fingerprint to compare and pin.
    SelfSigned(String),
}

pub async fn probe(base: &str) -> Result<Probe> {
    let url = format!("{base}/api2/json/version");
    // No token goes with either request: a 401 is still an answer.
    if http(tls_public())?.get(&url).send().await.is_ok() {
        return Ok(Probe::Public);
    }
    let pin = Arc::new(Pin {
        want: None,
        seen: Mutex::new(None),
        algorithms: provider().signature_verification_algorithms,
    });
    let outcome = http(tls_pinned(pin.clone()))?.get(&url).send().await;
    let seen = pin.seen.lock().unwrap().clone();
    match (seen, outcome) {
        (Some(print), _) => Ok(Probe::SelfSigned(print)),
        (None, Err(e)) => Err(err(format!("could not reach {base}: {}", root_cause(&e)))),
        (None, Ok(_)) => Err(err(format!("{base} answered without a certificate"))),
    }
}

fn root_cause(e: &dyn std::error::Error) -> String {
    let mut cause = e;
    while let Some(next) = cause.source() {
        cause = next;
    }
    cause.to_string()
}

/// What a guest's power can be told to do.
pub const POWER_ACTIONS: [&str; 3] = ["start", "shutdown", "stop"];

/// One guest or node, as far as the bridge itself needs to know it.
#[derive(Clone, Debug, PartialEq)]
pub struct Guest {
    pub vmid: u64,
    pub node: String,
    /// `lxc` or `qemu`.
    pub kind: String,
}

/// A reading of the cluster: the JSON the page is sent, and where each
/// guest lives so a console can be opened on it.
pub struct Reading {
    pub snapshot: Value,
    pub guests: Vec<Guest>,
}

pub type ConsoleStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub struct Client {
    base: String,
    auth: String,
    http: reqwest::Client,
    tls: Arc<ClientConfig>,
}

impl Client {
    pub fn new(settings: &config::Proxmox) -> Result<Client> {
        let base = base_url(&settings.url)?;
        let tls = match &settings.fingerprint {
            Some(print) => {
                let want = normalise_fingerprint(print);
                if want.len() != 64 {
                    return Err(err("the certificate fingerprint should be 32 bytes of SHA-256"));
                }
                tls_pinned(Arc::new(Pin {
                    want: Some(want),
                    seen: Mutex::new(None),
                    algorithms: provider().signature_verification_algorithms,
                }))
            }
            None => tls_public(),
        };
        if settings.token_id.contains(['=', '\n', '\r']) || settings.token_secret.contains(['\n', '\r']) {
            return Err(err("the API token has characters a token cannot have"));
        }
        Ok(Client {
            auth: format!("PVEAPIToken={}={}", settings.token_id.trim(), settings.token_secret.trim()),
            http: http(tls.clone())?,
            tls: Arc::new(tls),
            base,
        })
    }

    async fn answer(&self, request: reqwest::RequestBuilder, what: &str) -> Result<Value> {
        let response = request
            .header("Authorization", &self.auth)
            .send()
            .await
            .map_err(|e| err(format!("{what}: {}", root_cause(&e))))?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            // Proxmox puts the reason in the status line, and sometimes a
            // longer one in the body.
            let detail = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| v.get("message").and_then(Value::as_str).map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .or_else(|| status.canonical_reason().map(String::from))
                .unwrap_or_default();
            return Err(err(match status.as_u16() {
                401 => format!("{what}: Proxmox refused the API token ({detail})"),
                403 => format!("{what}: the API token is not allowed to ({detail})"),
                code => format!("{what}: Proxmox answered {code} {detail}"),
            }));
        }
        let value: Value = serde_json::from_str(&body).map_err(|_| err(format!("{what}: the answer was not JSON")))?;
        Ok(value.get("data").cloned().unwrap_or(Value::Null))
    }

    async fn get(&self, path: &str, what: &str) -> Result<Value> {
        self.answer(self.http.get(format!("{}/api2/json{path}", self.base)), what).await
    }

    async fn post(&self, path: &str, form: &[(&str, &str)], what: &str) -> Result<Value> {
        self.answer(self.http.post(format!("{}/api2/json{path}", self.base)).form(form), what)
            .await
    }

    /// The Proxmox VE version, which is also the cheapest way to find out
    /// whether the token works at all.
    pub async fn version(&self) -> Result<String> {
        let data = self.get("/version", "asking the version").await?;
        Ok(data.get("version").and_then(Value::as_str).unwrap_or("?").to_string())
    }

    /// Every node, guest and storage the token may see, in the shape the
    /// page draws, with what the room's gear shows besides: the cluster's
    /// quorum and its latest tasks.
    pub async fn read(&self) -> Result<Reading> {
        let data = self.get("/cluster/resources", "reading the cluster").await?;
        let rows = data.as_array().cloned().unwrap_or_default();

        // The load average, I/O wait and swap are not in the cluster
        // listing. Without Sys.Audit on a node they stay unknown, as do the
        // tasks and the quorum; none of that stops a reading.
        let online: Vec<String> = rows
            .iter()
            .filter(|row| text(row, "type") == "node" && text(row, "status") == "online")
            .map(|row| text(row, "node"))
            .collect();
        let details = futures_util::future::join_all(
            online
                .iter()
                .map(|name| async move { self.get(&format!("/nodes/{name}/status"), "reading a node").await.ok() }),
        );
        // The time of day is the host's own, in its own time zone: any
        // node that is up can say.
        let time = async {
            match online.first() {
                Some(name) => self.get(&format!("/nodes/{name}/time"), "reading the time").await.ok(),
                None => None,
            }
        };
        let (details, tasks, status, time) = tokio::join!(
            details,
            self.get("/cluster/tasks", "reading the tasks"),
            self.get("/cluster/status", "reading the quorum"),
            time
        );

        let mut nodes = Vec::new();
        let mut guests = Vec::new();
        let mut storage: Vec<Value> = Vec::new();
        let mut refs = Vec::new();
        for row in &rows {
            match text(row, "type").as_str() {
                "node" => {
                    let name = text(row, "node");
                    let detail = online.iter().position(|n| *n == name).and_then(|at| details[at].as_ref());
                    let load = detail
                        .and_then(|s| s.get("loadavg"))
                        .and_then(|l| l.as_array().map(|a| a.iter().map(number).collect::<Vec<f64>>()));
                    let part = |of: &str, key: &str| detail.and_then(|s| s.get(of)).and_then(|o| o.get(key)).map(number);
                    nodes.push(serde_json::json!({
                        "node": name,
                        "status": text(row, "status"),
                        "cpu": field(row, "cpu"),
                        "maxcpu": field(row, "maxcpu"),
                        "mem": field(row, "mem"),
                        "maxmem": field(row, "maxmem"),
                        "disk": field(row, "disk"),
                        "maxdisk": field(row, "maxdisk"),
                        "uptime": field(row, "uptime"),
                        "loadavg": load,
                        "wait": detail.and_then(|s| s.get("wait")).map(number),
                        "swap": part("swap", "used"),
                        "maxswap": part("swap", "total"),
                        "version": detail.and_then(|s| s.get("pveversion")).and_then(Value::as_str).map(pve_version),
                    }));
                }
                kind @ ("lxc" | "qemu") => {
                    if field(row, "template") != 0.0 {
                        continue;
                    }
                    let vmid = field(row, "vmid") as u64;
                    let status = text(row, "status");
                    let name = match text(row, "name") {
                        n if n.is_empty() => format!("{kind}-{vmid}"),
                        n => n,
                    };
                    guests.push(serde_json::json!({
                        "vmid": vmid,
                        "name": name,
                        "type": kind,
                        "node": text(row, "node"),
                        "status": shown_status(&status),
                        "cpu": field(row, "cpu"),
                        "maxcpu": field(row, "maxcpu"),
                        "mem": field(row, "mem"),
                        "maxmem": field(row, "maxmem"),
                        "disk": field(row, "disk"),
                        "maxdisk": field(row, "maxdisk"),
                        "netin": field(row, "netin"),
                        "netout": field(row, "netout"),
                        "diskread": field(row, "diskread"),
                        "diskwrite": field(row, "diskwrite"),
                        "uptime": field(row, "uptime"),
                        "tags": text(row, "tags"),
                    }));
                    refs.push(Guest {
                        vmid,
                        node: text(row, "node"),
                        kind: kind.to_string(),
                    });
                }
                "storage" => {
                    // Shared storage is listed once for every node; it is
                    // one storage.
                    let shared = field(row, "shared") != 0.0;
                    let name = text(row, "storage");
                    if shared && storage.iter().any(|s| s["shared"] == true && s["storage"] == name.as_str()) {
                        continue;
                    }
                    storage.push(serde_json::json!({
                        "storage": name,
                        "node": if shared { String::new() } else { text(row, "node") },
                        "shared": shared,
                        "kind": text(row, "plugintype"),
                        "status": text(row, "status"),
                        "disk": field(row, "disk"),
                        "maxdisk": field(row, "maxdisk"),
                    }));
                }
                _ => {}
            }
        }
        nodes.sort_by_key(|n| n["node"].as_str().unwrap_or("").to_string());
        storage.sort_by_key(|s| {
            (
                s["storage"].as_str().unwrap_or("").to_string(),
                s["node"].as_str().unwrap_or("").to_string(),
            )
        });
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        Ok(Reading {
            snapshot: serde_json::json!({
                "t": now,
                "nodes": nodes,
                "guests": guests,
                "storage": storage,
                "tasks": tasks.ok().map(|t| shown_tasks(&t)),
                "cluster": status.ok().map(|s| shown_cluster(&s)),
                "time": time.as_ref().and_then(time_of_day),
            }),
            guests: refs,
        })
    }

    /// Starts the guest (`start`), asks it to shut down (`shutdown`) or
    /// cuts its power (`stop`). Proxmox answers at once and does the work
    /// as a task; a later reading shows how it went.
    pub async fn power(&self, guest: &Guest, action: &str) -> Result<()> {
        if !POWER_ACTIONS.contains(&action) {
            return Err(err(format!("there is no power action called {action}")));
        }
        let path = format!("/nodes/{}/{}/{}/status/{action}", guest.node, guest.kind, guest.vmid);
        self.post(&path, &[], "switching the guest").await.map(|_| ())
    }

    /// Opens the guest's terminal: the one `pct console` or a VM's serial
    /// port gives, the same the Proxmox web interface shows as xterm.js.
    pub async fn console(&self, guest: &Guest) -> Result<Console> {
        let path = format!("/nodes/{}/{}/{}", guest.node, guest.kind, guest.vmid);
        let proxy = self.post(&format!("{path}/termproxy"), &[], "opening the console").await?;
        let port = number(proxy.get("port").unwrap_or(&Value::Null)) as u64;
        let ticket = proxy.get("ticket").and_then(Value::as_str).unwrap_or("");
        let user = proxy.get("user").and_then(Value::as_str).unwrap_or("");
        if port == 0 || ticket.is_empty() {
            return Err(err("opening the console: Proxmox gave no ticket"));
        }

        let wss = format!(
            "wss{}/api2/json{path}/vncwebsocket?port={port}&vncticket={}",
            self.base.trim_start_matches("https"),
            percent(ticket)
        );
        let mut request = wss.into_client_request().map_err(|e| err(format!("opening the console: {e}")))?;
        let headers = request.headers_mut();
        headers.insert(
            "Authorization",
            HeaderValue::from_str(&self.auth).map_err(|_| err("the API token is not a header value"))?,
        );
        headers.insert("Sec-WebSocket-Protocol", HeaderValue::from_static("binary"));
        let connect = tokio_tungstenite::connect_async_tls_with_config(request, None, true, Some(Connector::Rustls(self.tls.clone())));
        let (mut stream, _) = tokio::time::timeout(TIMEOUT, connect)
            .await
            .map_err(|_| err("opening the console: Proxmox did not answer"))?
            .map_err(|e| err(format!("opening the console: {}", root_cause(&e))))?;

        // The terminal proxy wants the ticket once more, and says OK.
        stream
            .send(Message::binary(format!("{user}:{ticket}\n").into_bytes()))
            .await
            .map_err(|e| err(format!("opening the console: {e}")))?;
        let mut early = Vec::new();
        let greeted = tokio::time::timeout(TIMEOUT, async {
            while early.len() < 2 {
                match stream.next().await {
                    Some(Ok(Message::Binary(b))) => early.extend_from_slice(&b),
                    Some(Ok(Message::Text(t))) => early.extend_from_slice(t.as_bytes()),
                    Some(Ok(Message::Close(_))) | None => return false,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => return false,
                }
            }
            true
        })
        .await
        .unwrap_or(false);
        if !greeted || !early.starts_with(b"OK") {
            return Err(err("opening the console: the terminal proxy refused the ticket"));
        }
        early.drain(..2);
        Ok(Console { stream, early })
    }
}

/// An open terminal. What the guest prints arrives as it is; what is typed
/// goes up inside the terminal proxy's small framing.
pub struct Console {
    pub stream: ConsoleStream,
    /// Output that arrived along with the greeting.
    pub early: Vec<u8>,
}

/// Typed bytes, framed.
pub fn frame_input(bytes: &[u8]) -> Vec<u8> {
    let mut out = format!("0:{}:", bytes.len()).into_bytes();
    out.extend_from_slice(bytes);
    out
}

/// A change of the terminal's size, framed.
pub fn frame_resize(cols: u16, rows: u16) -> Vec<u8> {
    format!("1:{cols}:{rows}:").into_bytes()
}

/// Keeps an idle console from being dropped.
pub const FRAME_PING: &[u8] = b"2";

/// The page knows two states. A paused or suspended guest still has its
/// console, so it is running. A guest whose node cannot be reached is
/// listed as `unknown`: nothing can be done with it, so it is stopped.
fn shown_status(status: &str) -> &'static str {
    match status {
        "stopped" | "unknown" => "stopped",
        _ => "running",
    }
}

/// How many of the latest tasks the page is sent.
const TASKS: usize = 60;

/// The latest tasks, newest first. One still running has no `end` and no
/// `status`; a finished one's status is `OK` or what went wrong.
fn shown_tasks(data: &Value) -> Vec<Value> {
    let mut tasks: Vec<&Value> = data.as_array().map(|a| a.iter().collect()).unwrap_or_default();
    tasks.sort_by(|a, b| field(b, "starttime").total_cmp(&field(a, "starttime")));
    tasks
        .into_iter()
        .take(TASKS)
        .map(|task| {
            let ended = task.get("endtime").map(number).filter(|end| *end > 0.0);
            serde_json::json!({
                "type": text(task, "type"),
                "id": text(task, "id"),
                "node": text(task, "node"),
                "user": text(task, "user"),
                "start": field(task, "starttime"),
                "end": ended,
                "status": ended.map(|_| text(task, "status")),
            })
        })
        .collect()
}

/// The cluster's name and whether it has quorum. A host that is in no
/// cluster has neither, and nothing to lose.
fn shown_cluster(data: &Value) -> Value {
    let cluster = data
        .as_array()
        .and_then(|rows| rows.iter().find(|row| text(row, "type") == "cluster"));
    serde_json::json!({
        "name": cluster.map(|c| text(c, "name")),
        "quorate": cluster.map(|c| field(c, "quorate") != 0.0),
    })
}

/// Seconds since midnight on the host: Proxmox gives its local time as
/// seconds since 1970 with its time zone's offset already added.
fn time_of_day(data: &Value) -> Option<f64> {
    let local = data.get("localtime").map(number).filter(|t| *t > 0.0)?;
    Some(local.rem_euclid(86400.0))
}

/// `9.0.3` from `pve-manager/9.0.3/025864202ebb6109`.
fn pve_version(text: &str) -> String {
    text.split('/').nth(1).unwrap_or(text).to_string()
}

fn text(row: &Value, key: &str) -> String {
    row.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn field(row: &Value, key: &str) -> f64 {
    row.get(key).map(number).unwrap_or(0.0)
}

/// Proxmox gives most numbers as numbers and a few as strings.
fn number(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) => s.trim().parse().unwrap_or(0.0),
        Value::Bool(b) => f64::from(u8::from(*b)),
        _ => 0.0,
    }
}

/// Percent-encodes everything but the unreserved characters. A ticket is
/// full of `+`, `/`, `=` and `:`.
fn percent(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_gets_the_scheme_and_port_it_was_typed_without() {
        assert_eq!(base_url("192.168.1.10").unwrap(), "https://192.168.1.10:8006");
        assert_eq!(base_url(" pve.lan:8006/ ").unwrap(), "https://pve.lan:8006");
        assert_eq!(base_url("https://pve.lan/#v1:0:18:4").unwrap(), "https://pve.lan:8006");
        assert_eq!(base_url("https://pve.example.com:443").unwrap(), "https://pve.example.com:443");
        assert_eq!(base_url("[fd00::1]").unwrap(), "https://[fd00::1]:8006");
        assert_eq!(base_url("[fd00::1]:8006").unwrap(), "https://[fd00::1]:8006");
        assert!(base_url("http://pve.lan:8006").is_err());
        assert!(base_url("").is_err());
        assert!(base_url("user@pve.lan").is_err());
    }

    #[test]
    fn a_fingerprint_is_the_same_however_it_is_typed() {
        let print = fingerprint(b"certificate");
        assert_eq!(print.len(), 32 * 3 - 1);
        assert_eq!(
            normalise_fingerprint(&print.to_lowercase()),
            normalise_fingerprint(&print.replace(':', " "))
        );
        assert_eq!(normalise_fingerprint(&print).len(), 64);
    }

    #[test]
    fn typing_and_resizing_are_framed_for_the_terminal_proxy() {
        assert_eq!(frame_input(b"ls\r"), b"0:3:ls\r");
        assert_eq!(frame_input("é".as_bytes()), b"0:2:\xc3\xa9");
        assert_eq!(frame_resize(80, 25), b"1:80:25:");
    }

    #[test]
    fn a_ticket_survives_a_query_string() {
        assert_eq!(percent("PVEVNC:6A+b/c=="), "PVEVNC%3A6A%2Bb%2Fc%3D%3D");
    }

    #[test]
    fn a_guest_on_an_unreachable_node_is_not_running() {
        assert_eq!(shown_status("running"), "running");
        assert_eq!(shown_status("paused"), "running");
        assert_eq!(shown_status("stopped"), "stopped");
        assert_eq!(shown_status("unknown"), "stopped");
    }

    #[test]
    fn tasks_come_newest_first_and_a_running_one_has_no_end() {
        let tasks = shown_tasks(&serde_json::json!([
            { "type": "vzdump", "id": "", "node": "pve1", "user": "root@pam", "starttime": 100, "endtime": 160, "status": "OK" },
            { "type": "vzstart", "id": "101", "node": "pve2", "user": "root@pam", "starttime": 300 },
            { "type": "qmstart", "id": "900", "node": "pve1", "user": "root@pam", "starttime": 200, "endtime": 201, "status": "no such VM" },
        ]));
        assert_eq!(tasks.len(), 3);
        assert_eq!(tasks[0]["type"], "vzstart");
        assert!(tasks[0]["end"].is_null() && tasks[0]["status"].is_null());
        assert_eq!(tasks[1]["status"], "no such VM");
        assert_eq!(tasks[2]["end"], 160.0);
        assert_eq!(shown_tasks(&Value::Null).len(), 0);
    }

    #[test]
    fn a_host_in_no_cluster_has_no_quorum_to_lose() {
        let alone = shown_cluster(&serde_json::json!([{ "type": "node", "name": "pve", "online": 1 }]));
        assert!(alone["name"].is_null() && alone["quorate"].is_null());
        let three = shown_cluster(&serde_json::json!([{ "type": "cluster", "name": "lab", "quorate": 1, "nodes": 3 }]));
        assert_eq!(three["name"], "lab");
        assert_eq!(three["quorate"], true);
        assert_eq!(pve_version("pve-manager/9.0.3/025864202ebb6109"), "9.0.3");
        let time = serde_json::json!({ "time": 1_795_000_000u64, "localtime": 86400u64 * 20_000 + 3661, "timezone": "Europe/Dublin" });
        assert_eq!(time_of_day(&time), Some(3661.0));
        assert_eq!(time_of_day(&Value::Null), None);
    }

    #[test]
    fn numbers_come_as_numbers_or_strings() {
        assert_eq!(number(&serde_json::json!("0.25")), 0.25);
        assert_eq!(number(&serde_json::json!(4)), 4.0);
        assert_eq!(number(&Value::Null), 0.0);
    }
}
