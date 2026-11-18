//! The bridge's settings: one TOML file, written by the setup card or by
//! hand. It holds the Proxmox API token, so the bridge writes it for its
//! owner alone, or for its owner and group where it was kept so before.

use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Config {
    /// Address the page is served on.
    #[serde(default = "default_listen")]
    pub listen: String,
    /// Seconds between readings of the cluster.
    #[serde(default = "default_poll")]
    pub poll_secs: u64,
    /// Argon2 hash of the password the page asks for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password_hash: Option<String>,
    /// Where visitors reach the page, for example `https://crt.example.com`.
    /// Browsers allow passkeys and single sign-on only over https with a
    /// certificate they trust, so those need to know. When it is https the
    /// cookies are marked to travel over nothing else.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxmox: Option<Proxmox>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oidc: Option<Oidc>,
    #[serde(default, skip_serializing_if = "SecondFactor::is_empty")]
    pub second_factor: SecondFactor,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Proxmox {
    /// Where the API is, for example `https://192.168.1.10:8006`.
    pub url: String,
    /// `user@realm!tokenname`.
    pub token_id: String,
    pub token_secret: String,
    /// SHA-256 fingerprint of the host's certificate, as Proxmox shows it
    /// (`AA:BB:...`). Without one the certificate has to chain to a public
    /// authority, as a Let's Encrypt one does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
}

/// Single sign-on: an OpenID Connect provider that says who is there, and
/// who of those it names may come in. Written by hand.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Oidc {
    /// The provider's issuer, exactly as the provider writes it, for
    /// example `https://accounts.example.com`.
    pub issuer: String,
    pub client_id: String,
    /// Left out for a client the provider registered as public.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    /// Who may come in: an email address the provider vouches for, or
    /// `sub:` and the provider's own identifier of an account. Empty lets
    /// nobody in.
    #[serde(default)]
    pub allow: Vec<String>,
    /// What the button on the log-in card says.
    #[serde(default = "default_label")]
    pub label: String,
    /// Whether the password still opens the page. When not, the provider
    /// is the only way in.
    #[serde(default = "yes")]
    pub password_login: bool,
}

/// What is asked for after the password, once any of it is enrolled.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct SecondFactor {
    /// The secret shared with an authenticator app, in base32.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_secret: Option<String>,
    /// The 30-second step of the newest code that was accepted. No code of
    /// that step or an earlier one is taken again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_last_step: Option<u64>,
    /// SHA-256, in hex, of each recovery code not used yet.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recovery: Vec<String>,
    /// The passkeys that may be used after the password.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub passkeys: Vec<Passkey>,
}

/// A passkey: a key pair made by a phone, a computer or a security key,
/// of which the bridge keeps the public half.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Passkey {
    /// What the bridge calls it, for removing it.
    pub id: String,
    /// What its owner called it.
    pub name: String,
    /// When it was added, in seconds since 1970.
    pub added: u64,
    /// The public key, its counter and what else the WebAuthn library
    /// keeps of it, as that library writes it: JSON.
    pub credential: String,
}

impl SecondFactor {
    pub fn is_empty(&self) -> bool {
        *self == SecondFactor::default()
    }

    /// Whether the password alone no longer opens the page.
    pub fn enrolled(&self) -> bool {
        self.totp_secret.is_some() || !self.passkeys.is_empty()
    }
}

fn default_listen() -> String {
    "0.0.0.0:8086".into()
}

fn default_poll() -> u64 {
    2
}

fn default_label() -> String {
    "Sign in with single sign-on".into()
}

fn yes() -> bool {
    true
}

impl Config {
    pub fn new() -> Config {
        Config {
            listen: default_listen(),
            poll_secs: default_poll(),
            password_hash: None,
            public_url: None,
            proxmox: None,
            oidc: None,
            second_factor: SecondFactor::default(),
        }
    }

    /// Whether the password is a way in. It is unless the single sign-on
    /// settings say the provider is to be the only one.
    pub fn password_login(&self) -> bool {
        self.oidc.as_ref().is_none_or(|oidc| oidc.password_login)
    }

    /// Whether the page is reached over https, going by `public_url`.
    pub fn https(&self) -> bool {
        self.public_url.as_deref().is_some_and(|url| scheme_is(url, "https://"))
    }

    /// Whether a browser will allow passkeys and single sign-on at
    /// `public_url`: over https, or on the machine itself.
    pub fn trusted_origin(&self) -> bool {
        self.public_url.as_deref().is_some_and(|url| {
            let local = ["http://localhost", "http://localhost/"];
            scheme_is(url, "https://") || local.contains(&url.trim()) || scheme_is(url, "http://localhost:")
        })
    }

    /// Whether the setup card has been filled in.
    pub fn configured(&self) -> bool {
        self.password_hash.is_some() && self.proxmox.is_some()
    }

    /// Reads the file; one that does not exist yet is an empty configuration.
    pub fn load(path: &Path) -> io::Result<Config> {
        match std::fs::read_to_string(path) {
            Ok(text) => toml::from_str(&text).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string())),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Config::new()),
            Err(e) => Err(e),
        }
    }

    /// Writes the file whole: to a neighbour first, then renamed over it, so
    /// a crash never leaves half a configuration. The new file keeps the
    /// old one's owner, so that root can change the settings of a bridge
    /// that runs as its own user. Comments in the old file are not kept.
    pub fn save(&self, path: &Path) -> io::Result<()> {
        let text = toml::to_string_pretty(self).map_err(|e| io::Error::other(e.to_string()))?;
        if let Some(dir) = path.parent()
            && !dir.as_os_str().is_empty()
        {
            std::fs::create_dir_all(dir)?;
        }
        let mut tmp = PathBuf::from(path);
        tmp.set_extension("toml.new");
        let written = write_private(&tmp, &text)
            .and_then(|()| keep_owner(path, &tmp))
            .and_then(|()| std::fs::rename(&tmp, path));
        if written.is_err() {
            // The neighbour holds the token: it is not left lying about.
            let _ = std::fs::remove_file(&tmp);
        }
        written
    }
}

fn scheme_is(url: &str, scheme: &str) -> bool {
    let url = url.trim();
    url.len() > scheme.len() && url[..scheme.len()].eq_ignore_ascii_case(scheme)
}

/// Gives the new file the old one's owner and group, and lets the group do
/// with it what it could with the old one. Nobody else gets anything.
#[cfg(unix)]
fn keep_owner(old: &Path, new: &Path) -> io::Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let Ok(old) = std::fs::metadata(old) else {
        return Ok(());
    };
    let now = std::fs::metadata(new)?;
    if (old.uid(), old.gid()) != (now.uid(), now.gid()) {
        match std::os::unix::fs::chown(new, Some(old.uid()), Some(old.gid())) {
            Ok(()) => {}
            // Only root can give a file away. A bridge that runs as its own
            // user and finds a file that root put there writes one of its
            // own in its place, private as it was made.
            Err(e) if e.kind() == io::ErrorKind::PermissionDenied => return Ok(()),
            Err(e) => return Err(e),
        }
    }
    // A file that root owns and the bridge reads through its group stays
    // readable to the bridge. One that anyone could read was not shared
    // on purpose, and is made private.
    let shared = if old.mode() & 0o007 == 0 { old.mode() & 0o060 } else { 0 };
    std::fs::set_permissions(new, std::fs::Permissions::from_mode(0o600 | shared))
}

#[cfg(not(unix))]
fn keep_owner(_old: &Path, _new: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn write_private(path: &Path, text: &str) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let _ = std::fs::remove_file(path);
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()
}

#[cfg(not(unix))]
fn write_private(path: &Path, text: &str) -> io::Result<()> {
    std::fs::write(path, text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_file_is_an_empty_configuration() {
        let config = Config::load(Path::new("/nonexistent/proxmox-crt.toml")).unwrap();
        assert!(!config.configured());
        assert_eq!(config.listen, "0.0.0.0:8086");
    }

    #[test]
    fn what_is_saved_loads_back_the_same() {
        let dir = std::env::temp_dir().join(format!("proxmox-crt-config-{}", std::process::id()));
        let path = dir.join("config.toml");
        let mut config = Config::new();
        config.password_hash = Some("$argon2id$x".into());
        config.proxmox = Some(Proxmox {
            url: "https://pve.example:8006".into(),
            token_id: "crt@pve!wall".into(),
            token_secret: "secret".into(),
            fingerprint: Some("AA:BB".into()),
        });
        config.save(&path).unwrap();
        assert_eq!(Config::load(&path).unwrap(), config);
        // Nothing of a second factor is written before one is enrolled.
        assert!(!std::fs::read_to_string(&path).unwrap().contains("second_factor"));

        config.public_url = Some("https://crt.example.com".into());
        config.second_factor = SecondFactor {
            totp_secret: Some("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ".into()),
            totp_last_step: Some(58_000_000),
            recovery: vec!["ab".repeat(32), "cd".repeat(32)],
            passkeys: vec![Passkey {
                id: "0123456789abcdef".into(),
                name: "Phone".into(),
                added: 1_795_000_000,
                credential: r#"{"cred":{"cred_id":"uZcV","counter":2,"note":"it's \"quoted\""}}"#.into(),
            }],
        };
        config.save(&path).unwrap();
        assert_eq!(Config::load(&path).unwrap(), config);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("[second_factor]"), "{text}");
        assert!(text.contains("[[second_factor.passkeys]]"), "{text}");
        assert!(text.contains("public_url = \"https://crt.example.com\""), "{text}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn the_file_stays_with_whom_it_was_with_and_no_one_else() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("proxmox-crt-config-mode-{}", std::process::id()));
        let path = dir.join("config.toml");
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        let config = Config::new();
        config.save(&path).unwrap();
        assert_eq!(mode(&path), 0o600);
        // A group that the old file was kept for can read the new one. A
        // file that was open to everyone is closed.
        for (before, after) in [
            (0o640, 0o640),
            (0o660, 0o660),
            (0o400, 0o600),
            (0o644, 0o600),
            (0o666, 0o600),
            (0o755, 0o600),
        ] {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(before)).unwrap();
            config.save(&path).unwrap();
            assert_eq!(mode(&path), after, "{before:o}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_write_that_fails_leaves_nothing_behind() {
        let dir = std::env::temp_dir().join(format!("proxmox-crt-config-failed-{}", std::process::id()));
        // A folder where the file should be: nothing can be renamed over it.
        let path = dir.join("config.toml");
        std::fs::create_dir_all(path.join("in-the-way")).unwrap();
        let mut config = Config::new();
        config.password_hash = Some("$argon2id$x".into());
        assert!(config.save(&path).is_err());
        assert!(!dir.join("config.toml.new").exists());
        assert!(path.is_dir());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_file_written_by_hand_may_leave_the_second_factor_out_or_spell_it_out() {
        let plain: Config = toml::from_str("listen = \"127.0.0.1:8086\"\n").unwrap();
        assert!(plain.second_factor.is_empty());
        assert!(!plain.second_factor.enrolled());
        assert_eq!(plain.public_url, None);

        let text = "public_url = \"https://crt.example.com\"\n\n[second_factor]\ntotp_secret = \"GEZDGNBVGY3TQOJQ\"\n";
        let config: Config = toml::from_str(text).unwrap();
        assert!(config.second_factor.enrolled());
        assert_eq!(config.second_factor.totp_last_step, None);
        assert!(config.second_factor.recovery.is_empty());
        assert!(config.second_factor.passkeys.is_empty());

        // A passkey alone is a second factor too.
        let text = "[[second_factor.passkeys]]\nid = \"0123456789abcdef\"\nname = \"Phone\"\nadded = 1795000000\ncredential = '{}'\n";
        let config: Config = toml::from_str(text).unwrap();
        assert!(config.second_factor.enrolled());
        assert_eq!(config.second_factor.passkeys[0].name, "Phone");
        assert_eq!(config.second_factor.totp_secret, None);
    }

    #[test]
    fn single_sign_on_is_written_by_hand_with_little_spelled_out() {
        let config: Config = toml::from_str("listen = \"127.0.0.1:8086\"\n").unwrap();
        assert_eq!(config.oidc, None);
        assert!(config.password_login());

        let text = "[oidc]\nissuer = \"https://accounts.example.com\"\nclient_id = \"wall\"\n";
        let config: Config = toml::from_str(text).unwrap();
        let oidc = config.oidc.clone().unwrap();
        assert_eq!(oidc.client_secret, None);
        assert!(oidc.allow.is_empty());
        assert_eq!(oidc.label, "Sign in with single sign-on");
        assert!(config.password_login());

        let text = format!(
            "{text}client_secret = \"s\"\nallow = [\"me@example.com\", \"sub:1234\"]\nlabel = \"Sign in with Example\"\npassword_login = false\n"
        );
        let mut config: Config = toml::from_str(&text).unwrap();
        assert!(!config.password_login());
        assert_eq!(config.oidc.as_ref().unwrap().allow, ["me@example.com", "sub:1234"]);
        // It survives the bridge writing the file, as when a code is used.
        config.second_factor.totp_secret = Some("GEZDGNBVGY3TQOJQ".into());
        let written = toml::to_string_pretty(&config).unwrap();
        assert_eq!(toml::from_str::<Config>(&written).unwrap(), config);
    }

    #[test]
    fn the_public_address_says_what_a_browser_will_allow() {
        let mut config = Config::new();
        assert!(!config.https());
        assert!(!config.trusted_origin());
        for (url, https, trusted) in [
            ("https://crt.example.com", true, true),
            ("HTTPS://crt.example.com/", true, true),
            ("http://crt.example.com", false, false),
            ("http://192.168.1.20:8086", false, false),
            ("http://localhost:8086", false, true),
            ("http://localhost", false, true),
            ("http://localhost.example.com", false, false),
            ("https://", false, false),
        ] {
            config.public_url = Some(url.into());
            assert_eq!(config.https(), https, "{url}");
            assert_eq!(config.trusted_origin(), trusted, "{url}");
        }
    }
}
