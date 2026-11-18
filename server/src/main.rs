use proxmox_crt::{App, Options, auth, serve};
use std::io::Read;
use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "\
proxmox-crt: serves the CRT wall and bridges it to Proxmox VE

Usage: proxmox-crt [options]

  --config <file>   settings file  (default /etc/proxmox-crt/config.toml)
  --client <dir>    the built page (default /opt/proxmox-crt/client)
  --listen <addr>   address to serve on, over the settings file's
                    (default 0.0.0.0:8086)
  --hash-password   read a password from standard input and print the hash
                    to put in the settings file as password_hash
  --version
  --help
";

fn main() -> ExitCode {
    let mut config = PathBuf::from("/etc/proxmox-crt/config.toml");
    let mut client = PathBuf::from("/opt/proxmox-crt/client");
    let mut listen = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut value = |name: &str| {
            args.next().unwrap_or_else(|| {
                eprintln!("{name} needs a value\n\n{USAGE}");
                std::process::exit(2)
            })
        };
        match arg.as_str() {
            "--config" => config = PathBuf::from(value("--config")),
            "--client" => client = PathBuf::from(value("--client")),
            "--listen" => listen = Some(value("--listen")),
            "--hash-password" => {
                let mut password = String::new();
                if std::io::stdin().read_to_string(&mut password).is_err() {
                    eprintln!("could not read the password");
                    return ExitCode::FAILURE;
                }
                let password = password.trim_end_matches(['\n', '\r']);
                if password.chars().count() < auth::MIN_PASSWORD {
                    eprintln!("the password needs at least {} characters", auth::MIN_PASSWORD);
                    return ExitCode::FAILURE;
                }
                return match auth::hash_password(password) {
                    Ok(hash) => {
                        println!("{hash}");
                        ExitCode::SUCCESS
                    }
                    Err(e) => {
                        eprintln!("{e}");
                        ExitCode::FAILURE
                    }
                };
            }
            "--version" => {
                println!("proxmox-crt {}", env!("CARGO_PKG_VERSION"));
                return ExitCode::SUCCESS;
            }
            "--help" | "-h" => {
                print!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            other => {
                eprintln!("unknown option {other}\n\n{USAGE}");
                return ExitCode::from(2);
            }
        }
    }

    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(e) => {
            eprintln!("could not start: {e}");
            return ExitCode::FAILURE;
        }
    };
    runtime.block_on(async move {
        let app = match App::new(&Options {
            config: config.clone(),
            client: client.clone(),
        }) {
            Ok(app) => app,
            Err(e) => {
                eprintln!("could not read {}: {e}", config.display());
                return ExitCode::FAILURE;
            }
        };
        let addr = listen.unwrap_or_else(|| app.listen());
        let listener = match tokio::net::TcpListener::bind(&addr).await {
            Ok(listener) => listener,
            Err(e) => {
                eprintln!("could not listen on {addr}: {e}");
                return ExitCode::FAILURE;
            }
        };
        eprintln!("proxmox-crt {} serving on http://{addr}/", env!("CARGO_PKG_VERSION"));
        if !client.join("index.html").exists() {
            eprintln!("warning: there is no page in {}", client.display());
        }
        if !app.configured() {
            eprintln!("Not set up yet. Open the page and enter this setup code: {}", app.setup_code());
        }
        match serve(app, client, listener).await {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("stopped: {e}");
                ExitCode::FAILURE
            }
        }
    })
}
