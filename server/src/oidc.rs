//! Single sign-on: logging in through an OpenID Connect provider in place
//! of the password. The browser is sent to the provider, comes back with a
//! code, and the bridge trades the code for an ID token that says who
//! signed in. The OpenID Connect library (openidconnect) reads the
//! provider's metadata and checks the token; this decides who of those the
//! provider names may come in, and knows each sign-in again when it comes
//! back.

use crate::config::{Config, Oidc};
use crate::{App, auth, pve};
use axum::extract::{Query, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_SECURITY_POLICY, COOKIE, LOCATION, SET_COOKIE};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{AppendHeaders, Html, IntoResponse, Response};
use data_encoding::{BASE64URL_NOPAD, HEXLOWER};
use hmac::{Hmac, KeyInit, Mac};
use openidconnect::core::{
    CoreAuthenticationFlow, CoreClient, CoreIdToken, CoreIdTokenClaims, CoreJwsSigningAlgorithm, CoreProviderMetadata,
};
use openidconnect::url::{Host, Url};
use openidconnect::{
    AuthorizationCode, ClaimsVerificationError, ClientId, ClientSecret, CsrfToken, EndpointMaybeSet, EndpointNotSet, EndpointSet,
    HttpRequest, HttpResponse, IssuerUrl, Nonce, PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, Scope, TokenResponse,
};
use serde::Deserialize;
use sha2::Sha256;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// More answered sign-ins than this are not remembered at once: the one
/// nearest its end is forgotten for the newest. Until its ten minutes are
/// over that one could be answered a second time, by the browser that has
/// its cookie and with a code the provider has not yet taken.
const MOST_SPENT: usize = 4096;
/// How long the provider's metadata and keys are kept before they are read
/// again.
const PROVIDER_LIFE: Duration = Duration::from_secs(300);
/// How long a provider that could not be read is left alone. Starting a
/// sign-in takes no password, so anyone can have the bridge ask.
const FAILED_LIFE: Duration = Duration::from_secs(5);
/// A token whose signature does not check out may be signed with a key the
/// provider began to use since its keys were read, so they are read again,
/// but for all such tokens together not more often than this.
const AGAIN_GAP: Duration = Duration::from_secs(30);
const TIMEOUT: Duration = Duration::from_secs(10);
/// No answer of a provider's is anywhere near this long.
const LONGEST_ANSWER: usize = 1 << 20;
/// The ways of signing an ID token that are taken: those that need the
/// provider's private key. A token signed with the client's own secret, or
/// not signed at all, is not, whatever the provider's metadata says.
const SIGNED_BY_KEY: [CoreJwsSigningAlgorithm; 9] = [
    CoreJwsSigningAlgorithm::RsaSsaPkcs1V15Sha256,
    CoreJwsSigningAlgorithm::RsaSsaPkcs1V15Sha384,
    CoreJwsSigningAlgorithm::RsaSsaPkcs1V15Sha512,
    CoreJwsSigningAlgorithm::RsaSsaPssSha256,
    CoreJwsSigningAlgorithm::RsaSsaPssSha384,
    CoreJwsSigningAlgorithm::RsaSsaPssSha512,
    CoreJwsSigningAlgorithm::EcdsaP256Sha256,
    CoreJwsSigningAlgorithm::EcdsaP384Sha384,
    CoreJwsSigningAlgorithm::EdDsa,
];

const NOT_SET_UP: &str = "Single sign-on is not set up here.";
const UNREACHABLE: &str = "The sign-in provider could not be reached. Try again in a moment.";
const NOT_STARTED: &str = "That sign-in was not started here, or took too long. Try again.";
const NOT_CONFIRMED: &str = "The provider did not confirm who you are.";
const NOT_ALLOWED: &str = "This account is not allowed here.";

type Client = CoreClient<EndpointSet, EndpointNotSet, EndpointNotSet, EndpointNotSet, EndpointMaybeSet, EndpointMaybeSet>;

/// A sign-in that went to the provider: what it took along.
struct Flow {
    /// What the provider has to hand back untouched.
    state: String,
    /// What the ID token has to carry.
    nonce: String,
    /// What the code is traded in with (PKCE).
    verifier: String,
}

/// What the provider said of itself, and its keys.
struct Provider {
    metadata: CoreProviderMetadata,
    read: Instant,
}

/// When the provider was last asked in vain, and when its keys were last
/// read again for a token's sake.
#[derive(Default)]
struct Asked {
    failed: Option<Instant>,
    again: Option<Instant>,
}

/// What is known of the provider, and what tells this bridge's sign-ins
/// from any other. A sign-in that is away at the provider is kept nowhere
/// but in its browser's cookie, so there is no limit to how many can be
/// away at once, and nobody can crowd another's out by starting more. The
/// cookie says when the sign-in ends and carries a number of its own, and
/// is sealed with a key made when the bridge starts; the state, the nonce
/// and the PKCE verifier are worked out from the two with the same key.
pub(crate) struct SignIns {
    /// For asking the provider. `None` where single sign-on is not set up.
    http: Option<reqwest::Client>,
    provider: Mutex<Option<Arc<Provider>>>,
    /// Held by whoever is asking the provider, so that one asks and the
    /// rest wait for what it finds.
    asking: tokio::sync::Mutex<Asked>,
    key: [u8; 32],
    /// The sign-ins that were answered, each until it would have ended.
    spent: Mutex<HashMap<String, u64>>,
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Whether `url` is somewhere a sign-in may pass through: https, or plain
/// http on the machine itself, where nothing can listen in.
pub(crate) fn safe_address(url: &str) -> bool {
    let Ok(url) = Url::parse(url.trim()) else {
        return false;
    };
    let local = match url.host() {
        Some(Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => return false,
    };
    url.scheme() == "https" || (url.scheme() == "http" && local)
}

/// Whether the page's public address is one a provider can send a browser
/// back to.
pub(crate) fn possible(config: &Config) -> bool {
    config.public_url.as_deref().is_some_and(safe_address)
}

/// Where the provider sends the browser back to. It has to be registered
/// with the provider, letter for letter.
pub(crate) fn redirect_uri(public_url: &str) -> String {
    format!("{}/api/oidc/callback", public_url.trim().trim_end_matches('/'))
}

/// What is wrong with the single sign-on settings, if anything is.
fn trouble(config: &Config) -> Option<&'static str> {
    let oidc = config.oidc.as_ref()?;
    if !safe_address(&oidc.issuer) {
        return Some("oidc.issuer has to be an https address");
    }
    if oidc.client_id.trim().is_empty() {
        return Some("oidc.client_id is empty");
    }
    if !possible(config) {
        return Some("single sign-on needs public_url, the https address visitors reach the page at");
    }
    None
}

impl SignIns {
    /// Fails if single sign-on is set up in a way that cannot work, saying
    /// how. The provider itself is not asked anything until someone signs
    /// in, so the bridge starts whether or not it can be reached.
    pub(crate) fn new(config: &Config) -> Result<SignIns, String> {
        if let Some(wrong) = trouble(config) {
            return Err(wrong.into());
        }
        let http = match &config.oidc {
            Some(oidc) => Some(
                reqwest::Client::builder()
                    .tls_backend_preconfigured(pve::tls_public())
                    // A redirect could lead a request, and the client's
                    // secret with it, somewhere else than the provider.
                    .redirect(reqwest::redirect::Policy::none())
                    .https_only(Url::parse(oidc.issuer.trim()).is_ok_and(|url| url.scheme() == "https"))
                    .timeout(TIMEOUT)
                    .connect_timeout(TIMEOUT)
                    .build()
                    .map_err(|e| format!("could not build the HTTP client: {e}"))?,
            ),
            None => None,
        };
        let mut key = [0u8; 32];
        getrandom::fill(&mut key).expect("the system has a random source");
        Ok(SignIns {
            http,
            provider: Mutex::new(None),
            asking: tokio::sync::Mutex::new(Asked::default()),
            key,
            spent: Mutex::new(HashMap::new()),
        })
    }

    /// One of the things a sign-in is made of: `what` it is, sealed
    /// together with the sign-in's number and its end.
    fn part(&self, what: &str, id: &str, until: u64) -> Vec<u8> {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key).expect("an HMAC takes a key of any length");
        mac.update(format!("{what}.{until}.{id}").as_bytes());
        mac.finalize().into_bytes().to_vec()
    }

    fn flow(&self, id: &str, until: u64) -> Flow {
        let text = |what| BASE64URL_NOPAD.encode(&self.part(what, id, until));
        Flow {
            state: text("state"),
            nonce: text("nonce"),
            verifier: text("verifier"),
        }
    }

    /// A new sign-in that ends at `until`, and the cookie to know it by.
    fn begin(&self, until: u64) -> (String, Flow) {
        let id = auth::random_hex(16);
        let seal = HEXLOWER.encode(&self.part("cookie", &id, until));
        (format!("{until}.{id}.{seal}"), self.flow(&id, until))
    }

    /// The sign-in a cookie stands for, if the cookie is one this bridge
    /// gave out, its time is not over and it was not answered before. It
    /// counts as answered from here on.
    fn answer(&self, cookie: &str, now: u64) -> Option<Flow> {
        let mut parts = cookie.splitn(3, '.');
        let until: u64 = parts.next()?.parse().ok()?;
        let (id, seal) = (parts.next()?, parts.next()?);
        if !auth::same(seal, &HEXLOWER.encode(&self.part("cookie", id, until))) || until <= now {
            return None;
        }
        let mut spent = self.spent.lock().unwrap();
        spent.retain(|_, until| *until > now);
        if spent.contains_key(id) {
            return None;
        }
        if spent.len() >= MOST_SPENT
            && let Some(soonest) = spent.iter().min_by_key(|(_, until)| **until).map(|(id, _)| id.clone())
        {
            spent.remove(&soonest);
        }
        spent.insert(id.to_string(), until);
        Some(self.flow(id, until))
    }

    fn known(&self) -> Option<Arc<Provider>> {
        self.provider.lock().unwrap().clone()
    }

    /// What the provider says of itself, read from it if that was not done
    /// in the last few minutes. `None` if it cannot be read, which the log
    /// says more about.
    async fn provider(&self, oidc: &Oidc, http: &reqwest::Client) -> Option<Arc<Provider>> {
        let fresh = |known: Option<Arc<Provider>>| known.filter(|p| p.read.elapsed() < PROVIDER_LIFE);
        if let Some(known) = fresh(self.known()) {
            return Some(known);
        }
        let mut asked = self.asking.lock().await;
        // Someone else may have read it while this one waited.
        if let Some(known) = fresh(self.known()) {
            return Some(known);
        }
        self.read(&mut asked, oidc, http).await
    }

    /// The provider's metadata and keys read once more, after a token's
    /// signature did not check out against `had`. `None` if they were read
    /// again for that only a little while ago, or cannot be read.
    async fn provider_again(&self, had: &Arc<Provider>, oidc: &Oidc, http: &reqwest::Client) -> Option<Arc<Provider>> {
        let mut asked = self.asking.lock().await;
        if let Some(newer) = self.known().filter(|known| !Arc::ptr_eq(known, had)) {
            return Some(newer);
        }
        if asked.again.is_some_and(|at| at.elapsed() < AGAIN_GAP) {
            return None;
        }
        asked.again = Some(Instant::now());
        self.read(&mut asked, oidc, http).await
    }

    /// Asks the provider, unless it was asked in vain a moment ago.
    async fn read(&self, asked: &mut Asked, oidc: &Oidc, http: &reqwest::Client) -> Option<Arc<Provider>> {
        if asked.failed.is_some_and(|at| at.elapsed() < FAILED_LIFE) {
            return None;
        }
        match discover(oidc, http).await {
            Ok(metadata) => {
                asked.failed = None;
                let provider = Arc::new(Provider {
                    metadata,
                    read: Instant::now(),
                });
                *self.provider.lock().unwrap() = Some(provider.clone());
                Some(provider)
            }
            Err(why) => {
                eprintln!("single sign-on: {why}");
                asked.failed = Some(Instant::now());
                None
            }
        }
    }
}

async fn discover(oidc: &Oidc, http: &reqwest::Client) -> Result<CoreProviderMetadata, String> {
    let issuer = IssuerUrl::new(oidc.issuer.trim().to_string()).map_err(|e| e.to_string())?;
    // The library takes the metadata only if it names this very issuer.
    let metadata = CoreProviderMetadata::discover_async(issuer, &carrier(http))
        .await
        .map_err(|e| format!("could not read the provider's metadata: {}", chain(&e)))?;
    if !safe_address(metadata.authorization_endpoint().as_str()) {
        return Err("the provider's authorization endpoint is not https".into());
    }
    Ok(metadata)
}

type Carried = Pin<Box<dyn Future<Output = Result<HttpResponse, pve::Error>> + Send>>;

/// Carries the library's requests to the provider over the bridge's own
/// HTTP client, which trusts the public certificate authorities.
fn carrier(http: &reqwest::Client) -> impl Fn(HttpRequest) -> Carried + '_ {
    move |request| {
        let http = http.clone();
        Box::pin(async move {
            let failed = |e: &dyn std::error::Error| pve::Error(chain(e));
            let request = reqwest::Request::try_from(request).map_err(|e| failed(&e))?;
            let mut response = http.execute(request).await.map_err(|e| failed(&e))?;
            let mut answer = openidconnect::http::Response::builder().status(response.status());
            for (name, value) in response.headers() {
                answer = answer.header(name, value);
            }
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|e| failed(&e))? {
                if body.len() + chunk.len() > LONGEST_ANSWER {
                    return Err(pve::Error("the answer was too long".into()));
                }
                body.extend_from_slice(&chunk);
            }
            answer.body(body).map_err(|e| failed(&e))
        })
    }
}

/// An error and what caused it, down to the root.
fn chain(e: &dyn std::error::Error) -> String {
    let mut text = e.to_string();
    let mut cause = e.source();
    while let Some(next) = cause {
        text = format!("{text}: {next}");
        cause = next.source();
    }
    text
}

/// The library's client for the provider, as this bridge is known to it.
fn client(provider: &Provider, oidc: &Oidc, public_url: &str) -> Result<Client, String> {
    let redirect = RedirectUrl::new(redirect_uri(public_url)).map_err(|e| e.to_string())?;
    let secret = oidc.client_secret.clone().filter(|s| !s.is_empty()).map(ClientSecret::new);
    let id = ClientId::new(oidc.client_id.trim().to_string());
    Ok(CoreClient::from_provider_metadata(provider.metadata.clone(), id, secret).set_redirect_uri(redirect))
}

/// A small page of the bridge's own, for the stops of a sign-in that the
/// wall's page is not there for. It says `message`, and with `onward` goes
/// to the wall by itself. Nothing a provider or a visitor sent is put in
/// it.
fn page(status: StatusCode, message: &'static str, onward: bool, cookies: Vec<String>) -> Response {
    let (refresh, link) = match onward {
        true => ("<meta http-equiv=\"refresh\" content=\"0; url=../../\">", "Go to the wall"),
        false => ("", "Back to the wall"),
    };
    let html = format!(
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n{refresh}\n\
         <title>proxmox-crt</title>\n\
         <style>body{{margin:18vh auto;max-width:30em;padding:0 16px;font:15px/1.5 ui-monospace,Menlo,Consolas,monospace;\
         color:#8fcf9d;background:#050806}}a{{color:#6dff8d}}</style>\n\
         </head>\n<body>\n<p>{message}</p>\n<p><a href=\"../../\">{link}</a></p>\n</body>\n</html>\n"
    );
    let mut headers = vec![
        (CACHE_CONTROL, "no-store".to_string()),
        (CONTENT_SECURITY_POLICY, "default-src 'none'; style-src 'unsafe-inline'".to_string()),
    ];
    headers.extend(cookies.into_iter().map(|cookie| (SET_COOKIE, cookie)));
    (status, AppendHeaders(headers), Html(html)).into_response()
}

/// The settings a sign-in goes by: the provider's, and the page's public
/// address.
fn settings(app: &App) -> Option<(Oidc, String, reqwest::Client)> {
    let config = app.config.read().unwrap();
    Some((config.oidc.clone()?, config.public_url.clone()?, app.oidc.http.clone()?))
}

/// The start of a sign-in: sends the browser to the provider, with a
/// cookie to know it by when it comes back. The cookie has to be let
/// through on the way back from another site, which a strict one is not.
/// Nothing is kept of it here.
pub(crate) async fn start(State(app): State<Arc<App>>) -> Response {
    let Some((oidc, public_url, http)) = settings(&app) else {
        return page(StatusCode::NOT_FOUND, NOT_SET_UP, false, Vec::new());
    };
    let Some(provider) = app.oidc.provider(&oidc, &http).await else {
        return page(StatusCode::BAD_GATEWAY, UNREACHABLE, false, Vec::new());
    };
    let client = match client(&provider, &oidc, &public_url) {
        Ok(client) => client,
        Err(why) => {
            eprintln!("single sign-on: {why}");
            return page(StatusCode::BAD_GATEWAY, UNREACHABLE, false, Vec::new());
        }
    };
    let (cookie, flow) = app.oidc.begin(unix_now() + auth::OIDC_SECS);
    let challenge = PkceCodeChallenge::from_code_verifier_sha256(&PkceCodeVerifier::new(flow.verifier));
    let (state, nonce) = (flow.state, flow.nonce);
    let (url, _, _) = client
        .authorize_url(
            CoreAuthenticationFlow::AuthorizationCode,
            move || CsrfToken::new(state),
            move || Nonce::new(nonce),
        )
        .add_scope(Scope::new("email".into()))
        .set_pkce_challenge(challenge)
        .url();
    (
        StatusCode::SEE_OTHER,
        [
            (LOCATION, url.to_string()),
            (SET_COOKIE, auth::set_oidc_cookie(Some(&cookie), app.secure())),
            (CACHE_CONTROL, "no-store".into()),
        ],
    )
        .into_response()
}

/// What the provider sends the browser back with.
#[derive(Deserialize)]
pub(crate) struct Answer {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    state: Option<String>,
}

/// Whether the account an ID token names is on the list. `email` is the
/// token's only if the provider says it has verified it.
fn allowed(allow: &[String], subject: &str, email: Option<&str>) -> bool {
    allow.iter().any(|entry| match entry.trim().strip_prefix("sub:") {
        Some(listed) => listed == subject,
        None => !entry.trim().is_empty() && email.is_some_and(|email| email.to_lowercase() == entry.trim().to_lowercase()),
    })
}

/// What an ID token says, if it checks out. The library checks the token's
/// signature against the provider's keys, that it is from this issuer, for
/// this client, not run out, and carries the number this sign-in sent
/// along.
fn check<'a>(
    token: &'a CoreIdToken,
    client: &Client,
    provider: &Provider,
    nonce: &Nonce,
) -> Result<&'a CoreIdTokenClaims, ClaimsVerificationError> {
    let signed = provider.metadata.id_token_signing_alg_values_supported().iter();
    let verifier = client
        .id_token_verifier()
        .set_allowed_algs(signed.filter(|alg| SIGNED_BY_KEY.contains(alg)).cloned());
    token.claims(&verifier, nonce)
}

/// The end of a sign-in: the browser is back from the provider. The
/// answer has to belong to a sign-in this browser started, the code is
/// traded for an ID token, and whoever the token names has to be on the
/// list. Then the session is opened: the provider is trusted to have asked
/// for whatever second step it asks for, so the bridge asks for none.
pub(crate) async fn callback(State(app): State<Arc<App>>, headers: HeaderMap, Query(answer): Query<Answer>) -> Response {
    let secure = app.secure();
    // Whatever comes of it, the sign-in's cookie has done its work.
    let stop = |status, message| page(status, message, false, vec![auth::set_oidc_cookie(None, secure)]);
    let Some((oidc, public_url, http)) = settings(&app) else {
        return stop(StatusCode::NOT_FOUND, NOT_SET_UP);
    };
    // A sign-in is taken away by the first answer to it, right or wrong,
    // so none is answered twice.
    let cookies = headers.get(COOKIE).and_then(|v| v.to_str().ok());
    let flow = auth::cookie_value(cookies, auth::OIDC_COOKIE).and_then(|cookie| app.oidc.answer(cookie, unix_now()));
    let (Some(flow), Some(state)) = (flow, answer.state) else {
        return stop(StatusCode::BAD_REQUEST, NOT_STARTED);
    };
    if !auth::same(&state, &flow.state) {
        return stop(StatusCode::BAD_REQUEST, NOT_STARTED);
    }
    // Without a code the provider is saying why not, in its own words,
    // which are not for this page to repeat.
    let Some(code) = answer.code else {
        return stop(StatusCode::FORBIDDEN, NOT_CONFIRMED);
    };
    let Some(provider) = app.oidc.provider(&oidc, &http).await else {
        return stop(StatusCode::BAD_GATEWAY, UNREACHABLE);
    };
    let tokens = match client(&provider, &oidc, &public_url) {
        Ok(client) => match client.exchange_code(AuthorizationCode::new(code)) {
            Ok(request) => {
                let verifier = PkceCodeVerifier::new(flow.verifier);
                let traded = request.set_pkce_verifier(verifier).request_async(&carrier(&http)).await;
                traded.map(|tokens| (client, tokens)).map_err(|e| chain(&e))
            }
            Err(e) => Err(e.to_string()),
        },
        Err(why) => Err(why),
    };
    let (client, tokens) = match tokens {
        Ok(tokens) => tokens,
        Err(why) => {
            eprintln!("single sign-on: the provider did not take the code: {why}");
            return stop(StatusCode::BAD_GATEWAY, NOT_CONFIRMED);
        }
    };
    let Some(token) = tokens.id_token() else {
        eprintln!("single sign-on: the provider sent no ID token");
        return stop(StatusCode::FORBIDDEN, NOT_CONFIRMED);
    };
    let nonce = Nonce::new(flow.nonce);
    let mut checked = check(token, &client, &provider, &nonce);
    // A provider that has begun to sign with a new key since its keys
    // were read is asked for them again before its token is refused.
    if matches!(checked, Err(ClaimsVerificationError::SignatureVerification(_)))
        && let Some(newer) = app.oidc.provider_again(&provider, &oidc, &http).await
        && let Ok(client) = self::client(&newer, &oidc, &public_url)
    {
        checked = check(token, &client, &newer, &nonce);
    }
    let claims = match checked {
        Ok(claims) => claims,
        Err(e) => {
            eprintln!("single sign-on: the ID token did not check out: {}", chain(&e));
            return stop(StatusCode::FORBIDDEN, NOT_CONFIRMED);
        }
    };
    let subject = claims.subject().as_str();
    let email = claims.email().map(|email| email.as_str());
    let verified = claims.email_verified() == Some(true);
    if !allowed(&oidc.allow, subject, email.filter(|_| verified)) {
        // Said in the log the way it would be written in the list, for
        // an owner who means to put it there.
        let address = match email {
            Some(email) if verified => format!("verified email {email:?}"),
            Some(email) => format!("unverified email {email:?}"),
            None => "no email".into(),
        };
        eprintln!(
            "single sign-on: turned away an account that is not on the allow list: {:?}, {address}",
            format!("sub:{subject}")
        );
        return stop(StatusCode::FORBIDDEN, NOT_ALLOWED);
    }
    // The session's cookie is a strict one, and this answer ends a chain
    // of redirects that began on the provider's site, so a browser would
    // not send it along on a redirect from here. A page that goes to the
    // wall by itself starts afresh, from this site.
    let token = app.sessions.open();
    let cookies = vec![
        auth::set_cookie(Some(&token), secure),
        auth::set_pending_cookie(None, secure),
        auth::set_oidc_cookie(None, secure),
    ];
    page(StatusCode::OK, "Signed in.", true, cookies)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sign_in_passes_over_https_or_stays_on_the_machine() {
        for (url, ok) in [
            ("https://accounts.example.com", true),
            ("https://accounts.example.com/realms/home", true),
            (" https://192.168.1.20:8443/ ", true),
            ("http://localhost:8086", true),
            ("http://127.0.0.1:8086", true),
            ("http://[::1]:8086", true),
            ("http://accounts.example.com", false),
            ("http://192.168.1.20:8086", false),
            ("http://localhost.example.com", false),
            ("ftp://localhost", false),
            ("accounts.example.com", false),
            ("", false),
        ] {
            assert_eq!(safe_address(url), ok, "{url}");
        }
    }

    fn sign_ins() -> SignIns {
        SignIns::new(&Config::new()).unwrap()
    }

    #[test]
    fn a_sign_in_is_known_again_by_its_cookie_once() {
        let here = sign_ins();
        let (cookie, flow) = here.begin(1000);
        // The three things it takes along differ, and are long enough for
        // what each is used as (a PKCE verifier has 43 characters or more).
        assert_eq!((flow.state.len(), flow.nonce.len(), flow.verifier.len()), (43, 43, 43));
        assert!(flow.state != flow.nonce && flow.nonce != flow.verifier && flow.state != flow.verifier);
        assert!(!cookie.contains(&flow.state) && !cookie.contains(&flow.nonce) && !cookie.contains(&flow.verifier));
        let (other, another) = here.begin(1000);
        assert!(other != cookie && another.state != flow.state);

        // Not past its end, not with its end put off, not with another's
        // number or seal, and not at a bridge with another key.
        assert!(here.answer(&cookie, 1000).is_none());
        let parts: Vec<&str> = cookie.split('.').collect();
        let others: Vec<&str> = other.split('.').collect();
        for forged in [
            format!("2000.{}.{}", parts[1], parts[2]),
            format!("{}.{}.{}", parts[0], others[1], parts[2]),
            format!("{}.{}.{}", parts[0], parts[1], others[2]),
            format!("{}.{}", parts[0], parts[1]),
            String::new(),
        ] {
            assert!(here.answer(&forged, 999).is_none(), "{forged}");
        }
        assert!(sign_ins().answer(&cookie, 999).is_none());

        let back = here.answer(&cookie, 999).unwrap();
        assert_eq!((back.state, back.nonce, back.verifier), (flow.state, flow.nonce, flow.verifier));
        assert!(here.answer(&cookie, 999).is_none());
        // Once its time is over it is no longer remembered either.
        assert!(here.answer(&other, 1000).is_none());
        assert_eq!(here.spent.lock().unwrap().len(), 1);
        let (later, _) = here.begin(2000);
        assert!(here.answer(&later, 1500).is_some());
        assert_eq!(
            here.spent.lock().unwrap().keys().collect::<Vec<_>>(),
            [later.split('.').nth(1).unwrap()]
        );
    }

    #[test]
    fn any_number_of_sign_ins_can_be_away_and_few_answered_ones_are_forgotten() {
        let here = sign_ins();
        let (first, _) = here.begin(500);
        let many: Vec<String> = (0..MOST_SPENT as u64 + 10).map(|i| here.begin(1000 + i).0).collect();
        // Starting those took nothing from the first.
        assert!(here.answer(&first, 100).is_some());
        for cookie in &many {
            assert!(here.answer(cookie, 100).is_some());
        }
        assert_eq!(here.spent.lock().unwrap().len(), MOST_SPENT);
        // The newest are remembered as answered.
        assert!(here.answer(many.last().unwrap(), 100).is_none());
        assert!(here.answer(&many[many.len() / 2], 100).is_none());
    }

    #[test]
    fn the_provider_is_sent_back_to_the_public_address() {
        assert_eq!(redirect_uri("https://crt.example.com"), "https://crt.example.com/api/oidc/callback");
        assert_eq!(
            redirect_uri(" https://example.com/crt/ "),
            "https://example.com/crt/api/oidc/callback"
        );
    }

    #[test]
    fn settings_that_cannot_work_are_noticed() {
        let mut config = Config::new();
        assert_eq!(trouble(&config), None);
        assert!(SignIns::new(&config).unwrap().http.is_none());
        config.oidc = Some(Oidc {
            issuer: "https://accounts.example.com".into(),
            client_id: "wall".into(),
            client_secret: None,
            allow: Vec::new(),
            label: "Sign in".into(),
            password_login: false,
        });
        assert!(trouble(&config).unwrap().contains("public_url"));
        config.public_url = Some("http://192.168.1.20:8086".into());
        assert!(trouble(&config).unwrap().contains("public_url"));
        config.public_url = Some("https://crt.example.com".into());
        assert_eq!(trouble(&config), None);
        config.oidc.as_mut().unwrap().issuer = "http://accounts.example.com".into();
        assert!(trouble(&config).unwrap().contains("issuer"));
        config.oidc.as_mut().unwrap().issuer = "http://127.0.0.1:9000".into();
        assert_eq!(trouble(&config), None);
        config.oidc.as_mut().unwrap().client_id = " ".into();
        assert!(trouble(&config).unwrap().contains("client_id"));
    }

    #[test]
    fn only_who_is_on_the_list_comes_in() {
        let list = ["Me@Example.com".to_string(), " sub:1234 ".to_string(), String::new()];
        assert!(allowed(&list, "9", Some("me@example.com")));
        assert!(allowed(&list, "9", Some("ME@EXAMPLE.COM")));
        assert!(allowed(&list, "1234", None));
        assert!(!allowed(&list, "9", Some("you@example.com")));
        // An address the provider has not verified is no address.
        assert!(!allowed(&list, "9", None));
        // A subject is taken letter for letter, and is not an address.
        assert!(!allowed(&list, "12345", None));
        assert!(!allowed(&list, "me@example.com", None));
        assert!(!allowed(&list, "9", Some("sub:1234")));
        assert!(!allowed(&list, "", Some("")));
        assert!(!allowed(&[], "1234", Some("me@example.com")));
    }
}
