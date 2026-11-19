# Installing proxmox-crt

Two ways in: the Proxmox LXC scripts in `ct/` and `install/`, or by hand on any
Debian box. Both end with the same layout:

| Path | What it is |
|---|---|
| `/opt/proxmox-crt/proxmox-crt` | The bridge. |
| `/opt/proxmox-crt/client/` | The built page (`dist/`). |
| `/etc/proxmox-crt/config.toml` | Settings, written by the setup card, mode 0600. |
| `/etc/systemd/system/proxmox-crt.service` | The unit, from `deploy/proxmox-crt.service`. |

The bridge runs as the system user `proxmox-crt`, which owns `/etc/proxmox-crt`
and can write nowhere else. It serves plain http on port 8086.

## The setup code

The first visit to `http://<address>:8086` asks for a setup code. The bridge
prints it in its log each time it starts without settings:

```sh
journalctl -u proxmox-crt | grep "setup code" | tail -n 1
```

The code changes on every start, so use the last one. In the LXC, run that in
the container's console (`pct enter <id>` on the Proxmox host).

## The LXC scripts

`ct/proxmox-crt.sh` runs on the Proxmox host and makes a Debian 13 container
(2 cores, 2048 MB, 4 GB, unprivileged). `install/proxmox-crt-install.sh` runs
inside it: it installs Node.js 22, Rust and a C compiler, clones the default
branch, builds the page and the bridge, installs them, then removes the
compilers and the sources again.

The memory is for the Rust build. Once installed, the container can be given
less; an update needs the 2048 MB back.

They are written for [community-scripts](https://github.com/community-scripts/ProxmoxVE)
and use its engine, so they do not run on their own. Line 2 of the `ct/`
script says where the scripts live, which for now is this repository. On a
Proxmox host:

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/dubsector/proxmox-crt/main/ct/proxmox-crt.sh)"
```

Or from a checkout, where the engine finds `install/` beside `ct/`:

```sh
git clone https://github.com/dubsector/proxmox-crt
cd proxmox-crt
bash ct/proxmox-crt.sh
```

New scripts go to [DevScripts](https://github.com/community-scripts/DevScripts)
first. When these are sent there, line 2 has to name that repository instead.

To update, run `update` in the container (`pct enter <id>` on the Proxmox
host). It compares the installed commit, kept in `/root/.proxmox-crt`, with
the default branch; if they differ it rebuilds, replaces the bridge, the
page and the unit, and restarts the service. The settings are left alone.

A container made before line 2 named this repository looks for the scripts
elsewhere, and its `update` says `No update script found for 'proxmox-crt'`.
Run the script from here once, inside the container, and choose to update:

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/dubsector/proxmox-crt/main/ct/proxmox-crt.sh)"
```

That run also sets the container's `update` command right, so it works by
itself from then on.

## By hand on Debian

As root, with Node.js 22 or newer and a current stable Rust
([rustup](https://rustup.rs), minimal profile is enough):

```sh
apt install -y build-essential git
git clone https://github.com/dubsector/proxmox-crt
cd proxmox-crt

npm ci
npm run build
(cd server && cargo build --release --locked)

useradd --system --user-group --no-create-home --home-dir /nonexistent \
  --shell /usr/sbin/nologin proxmox-crt
mkdir -p /opt/proxmox-crt
install -m 755 server/target/release/proxmox-crt /opt/proxmox-crt/proxmox-crt
cp -r dist /opt/proxmox-crt/client
install -d -m 750 -o proxmox-crt -g proxmox-crt /etc/proxmox-crt
install -m 644 deploy/proxmox-crt.service /etc/systemd/system/proxmox-crt.service

systemctl daemon-reload
systemctl enable --now proxmox-crt
```

Then open the page and enter the setup code.

To update:

```sh
cd proxmox-crt
git pull
npm ci
npm run build
(cd server && cargo build --release --locked)

systemctl stop proxmox-crt
install -m 755 server/target/release/proxmox-crt /opt/proxmox-crt/proxmox-crt
rm -rf /opt/proxmox-crt/client
cp -r dist /opt/proxmox-crt/client
install -m 644 deploy/proxmox-crt.service /etc/systemd/system/proxmox-crt.service
systemctl daemon-reload
systemctl start proxmox-crt
```

To serve on another address, set `listen` in the settings file, or add
`--listen` to `ExecStart` with `systemctl edit proxmox-crt`.

## Not tested yet

The install has run from a checkout on a Proxmox VE 9.2 host, into a Debian
13 container, through to the setup card and a console. The rest has not:

- **The update:** change `main`, run `update`, see the new build serving and
  the settings kept.
- **The hardening in an unprivileged container.** `ProtectSystem=strict`,
  `PrivateDevices` and the others need mount namespaces, which an unprivileged
  LXC only has with nesting on (the community-scripts default). If the service
  fails with status 226, that is where to look.
- **Memory and disk.** 2048 MB and 4 GB are estimates: a release build here
  left 350 MB in `target/`, and the compilers add about 1.5 GB while they are
  installed. Watch the first build for an out-of-memory kill.
- **Removing the compilers.** The install script uses the engine's
  `remove_old_tool_version` and deletes its records in
  `/var/cache/app-versions`, so that the engine does not reinstall them on its
  own. Check that an update still finds everything it needs afterwards, and
  that `apt update` is clean with the NodeSource entry gone.
- **A failed update build.** The new commit is only recorded once the service
  has restarted, so after a failed build the next `update` should build again.
  The compilers and `/opt/proxmox-crt-src` stay installed until an update
  succeeds. Not tried in a real container.
- **arm64.** Not tried, so `var_arm64` is left unset and the user is asked.
- **shellcheck** was not available where the scripts were written.

Where the scripts depart from the community-scripts guide, which a reviewer
will ask about:

- A dedicated service user and a hardened unit. The guide wants services run
  as root, the container being the boundary. The bridge holds an API token
  that can open consoles, so it is kept unprivileged.
- The unit is copied from `deploy/` in the sources instead of written inline,
  so there is one copy of it.
- The compilers are removed after the build. Most scripts there keep them.
- The guide asks for an application with 1,000 stars, six months of history
  and release tarballs. With releases, the scripts could fetch a built bridge
  and page with `fetch_and_deploy_gh_release` and would need no compilers.
- Submission also needs `json/proxmox-crt.json` (name, port 8086, resources,
  notes), which is not written yet.
