# Changelog

What changed in each release, newest first. Containers take a release with
`update`.

## Unreleased

- The README is shorter and opens with a picture; the room's controls and the
  bridge's settings moved to `docs/`.
- The build check runs shellcheck on the LXC scripts, and a release runs each
  bridge it built before publishing it.

## 0.3.0 (2026-11-19)

The first release. Installs and updates take it ready-built in place of
compiling in the container.

- A wall of 13 x 4 monitors, one per guest, with the selected guest's console
  on the desk terminal: `pct console` for a container, the serial port for a
  VM. Scrollback, copy and paste.
- A guarded power switch for the selected guest, node monitors on the desk,
  and cabinets, meters and a plot that follow the nodes' load.
- The office modelled in Blender with baked light, ceiling lights that
  flicker on, a keyboard that types and follows real typing, a power button
  on the desk terminal, a desk lamp and a lava lamp with cord switches.
- The bridge in Rust: keeps the API token, pins a self-signed certificate,
  and writes its own settings from the setup card.
- Signing in: a password that can be changed, an authenticator app with
  recovery codes, passkeys, and single sign-on through an OpenID Connect
  provider. `trusted_proxies` counts wrong tries by the visitor's own address
  behind a reverse proxy.
- LXC scripts for Proxmox VE, a hardened systemd unit, and release builds for
  amd64 and arm64 with checksums.
