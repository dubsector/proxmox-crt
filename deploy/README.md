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
(1 core, 512 MB, 2 GB, unprivileged). `install/proxmox-crt-install.sh` runs
inside it: it downloads the latest
[release](https://github.com/dubsector/proxmox-crt/releases) for the
container's architecture (about 13 MB, the bridge as a static binary plus the
built page and the unit) and installs it. Nothing is compiled in the
container, so it needs no compilers and no build memory.

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
host). It compares the installed version, kept in `/root/.proxmox-crt`, with
the latest release; if they differ it downloads that release, replaces the
bridge, the page and the unit, and restarts the service. The settings are
left alone. The new files go in while the old bridge is still serving, and
only once the download has unpacked, so a failed download changes nothing.

A container from before the releases (it built the bridge itself, and
`/root/.proxmox-crt` holds a commit) takes the latest release on its next
`update`, and that update also removes any Node.js, Rust or sources a build
left behind. It can then be given 512 MB.

A container made before line 2 named this repository looks for the scripts
elsewhere, and its `update` says `No update script found for 'proxmox-crt'`.
Run the script from here once, inside the container, and choose to update:

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/dubsector/proxmox-crt/main/ct/proxmox-crt.sh)"
```

That run also sets the container's `update` command right, so it works by
itself from then on.

## Making a release

The installs and updates take the latest release, so a change on `main`
reaches containers only once it is released:

1. Move what is under "Unreleased" in `CHANGELOG.md` to a heading for the
   new version.
2. Raise `version` in `server/Cargo.toml` and `package.json` (and run
   `cargo update -p proxmox-crt --offline` in `server/` and `npm install
   --package-lock-only`, so the lock files carry it too). Merge that.
3. Tag the merge commit with the same version and push the tag:

   ```sh
   git tag v0.4.0
   git push origin v0.4.0
   ```

`.github/workflows/release.yml` checks the tag against both versions, builds
the bridge for amd64 and arm64 (static musl binaries) and the page, runs each
bridge once to see that it starts and says the tag's version, and
publishes `proxmox-crt-linux-amd64.tar.gz`, `proxmox-crt-linux-arm64.tar.gz`
and `SHA256SUMS` as the release. It takes a few minutes; until it finishes,
`update` still sees the previous release.

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

## What has been tested

The install has run on a Proxmox VE 9.2 host, into a Debian 13 container,
through to the setup card and a console. The release workflow has run on
GitHub's runners for both architectures (v0.3.0), and the amd64 release
checks against its `SHA256SUMS` and serves the page. The scripts pass
shellcheck, which the build check runs on every change.

Not tested yet:

- **The update from one release to the next:** release a new version, run
  `update`, see it serving and the settings kept.
- **The hardening in an unprivileged container.** `ProtectSystem=strict`,
  `PrivateDevices` and the others need mount namespaces, which an unprivileged
  LXC only has with nesting on (the community-scripts default). If the service
  fails with status 226, that is where to look.
- **Moving an old container over.** Its first `update` removes the build
  tools with the engine's `remove_old_tool_version` and deletes their records
  in `/var/cache/app-versions`. Check that `apt update` is clean afterwards,
  with the NodeSource entry gone.
- **A failed update.** The engine keeps a `.pending` marker beside
  `/root/.proxmox-crt` until a run finishes, so the next `update` tries again.
- **arm64.** A release is built for it but none has run, so `var_arm64` is
  left unset and the user is asked.

Where the scripts depart from the community-scripts guide, which a reviewer
will ask about:

- A dedicated service user and a hardened unit. The guide wants services run
  as root, the container being the boundary. The bridge holds an API token
  that can open consoles, so it is kept unprivileged.
- The unit is copied from `deploy/` in the sources instead of written inline,
  so there is one copy of it.
- The guide asks for an application with 1,000 stars and six months of
  history. The release tarballs it asks for are there.
- Submission also needs `json/proxmox-crt.json` (name, port 8086, resources,
  notes), which is not written yet.
