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
and use its engine, so they do not run on their own. New scripts go to
[DevScripts](https://github.com/community-scripts/DevScripts) first, which is
why line 2 of the `ct/` script points there. To try them from a checkout of
this repository on a Proxmox host (not yet tried, see below):

```sh
git clone https://github.com/dubsector/proxmox-crt
cd proxmox-crt
bash ct/proxmox-crt.sh
```

The engine looks for `install/` beside `ct/` in the checkout. Without a
checkout, `COMMUNITY_SCRIPTS_URL` has to name where the scripts are:

```sh
export COMMUNITY_SCRIPTS_URL=https://raw.githubusercontent.com/dubsector/proxmox-crt/main
bash -c "$(curl -fsSL "$COMMUNITY_SCRIPTS_URL/ct/proxmox-crt.sh")"
```

To update, run `update` in the container (or the `ct/` script again from
inside it). It compares the installed commit, kept in `/root/.proxmox-crt`,
with the default branch; if they differ it rebuilds, replaces the bridge, the
page and the unit, and restarts the service. The settings are left alone.

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

None of this has run on a Proxmox host or in a Debian 13 container. Checked so
far: `bash -n` on both scripts, and `systemd-analyze verify` on the unit
(systemd 255), which found nothing but the missing binary.

Before relying on it, or sending it to community-scripts:

- **The default branch has to hold the bridge.** The scripts build `main`.
  At the time of writing `main` had no `server/` and none of these files, so
  the build fails until they are merged.
- **A full run:** create the container, reach the page on 8086, read the setup
  code, finish the setup card, open a console.
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
- **A failed update build.** The commit is recorded when the sources are
  fetched, before the build. If the build then fails, the next `update` says
  there is nothing to do; delete `/root/.proxmox-crt` and run it again.
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
