//! The bridge's settings: one TOML file, written by the setup card or by
//! hand. It holds the Proxmox API token, so it is kept readable by its owner
//! only.

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxmox: Option<Proxmox>,
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

fn default_listen() -> String {
    "0.0.0.0:8086".into()
}

fn default_poll() -> u64 {
    2
}

impl Config {
    pub fn new() -> Config {
        Config {
            listen: default_listen(),
            poll_secs: default_poll(),
            password_hash: None,
            proxmox: None,
        }
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
    /// a crash never leaves half a configuration.
    pub fn save(&self, path: &Path) -> io::Result<()> {
        let text = toml::to_string_pretty(self).map_err(|e| io::Error::other(e.to_string()))?;
        if let Some(dir) = path.parent()
            && !dir.as_os_str().is_empty()
        {
            std::fs::create_dir_all(dir)?;
        }
        let mut tmp = PathBuf::from(path);
        tmp.set_extension("toml.new");
        write_private(&tmp, &text)?;
        std::fs::rename(&tmp, path)
    }
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
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
