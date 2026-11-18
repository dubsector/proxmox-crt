# proxmox-crt

A security office for your Proxmox host: a wall of CRT monitors, one per VM or
container, cabinets of blinking lamps and turning tape reels under it, and
on the desk a terminal for whichever guest you switch to and a monitor for
each node.

It grows out of [dubsector/terminal](https://github.com/dubsector/terminal),
whose tube shader, character ROM and way of drawing text as a video signal it
reuses.

## Where it stands

The scene is still grey-box: plain boxes under plain lights. Behind it, the
page now talks to a real Proxmox VE host through a small bridge, and the desk
terminal is a real terminal on whichever guest is selected. What works:

- A wall of small monitors, sized to the number of guests (4 x 3, 8 x 3 or
  13 x 4), each showing a guest's number, name, CPU and memory. Spare monitors
  stay off.
- A stopped guest shows OFFLINE. When a guest stops or starts, its monitor
  switches off (the picture folds to a line, then a dot) and warms up again
  with the new picture.
- Selecting a running guest puts its console on the desk terminal, ready to
  type into: the terminal `pct console` gives for a container, the serial
  port for a VM. The last four consoles stay attached, so going back to a
  guest finds its screen as it was. The numpad's `.` flips the desk between
  the console and the guest's figures (gauges, network rates, uptime, CPU
  history).
- A computer room under the wall, right across it: cabinets of
  blinking lamps and tape drives. Each of the first few follows one node, and
  blinks and winds as busily as that node is working.
- Racks beside the wall and in the corners, as a firing room has them, each
  with a clock (GMT, local, or time since the page opened), boards of status
  lamps, three meters and a scope. The meters of the two racks next to the
  monitors are real: the nodes' CPU on the left, their memory on the right.
- Two big boards beyond those racks, over more cabinets: a tracking chart on
  the left, and on the right a plot of each node's CPU over the last few
  minutes. A row of lit signs runs along the top, and the side walls have
  racks of their own. A wide window shows more of all this, and so does
  turning the view.
- The terminal's keyboard on the desk, whose keys go down as you type; a
  lava lamp; and what a shift leaves lying about: a logbook and pen, a mug,
  a headset and a desk lamp.
- A strip of small node monitors between the terminal and its keyboard, one
  per node (up to four), with each node's CPU, memory and guest count. They
  come into view when you look down at the desk; nothing selects them.
- The switcher on the desk: a box beside the terminal with a two-digit
  readout of the selected monitor and a lamp for that guest's power (green
  running, red stopped); a keypad that can be clicked and lights as the real
  numpad is typed; and a dial beside the keypad, turned by clicking either half of
  it or with the mouse wheel over it, that steps to the next or previous monitor.
  They are to the right of the terminal.
- The mouse wheel over the desk terminal's screen scrolls back through what
  the console printed (1000 lines); in a pager or an editor it sends the
  arrow keys.
- Copy and paste: drag across the desk terminal's screen to select text, and
  letting go copies it (Ctrl+Shift+C copies it again). Ctrl+V pastes into the
  guest.
- Power: the switcher box has a guarded switch for the selected guest. Click
  the red cover (or press numpad `*`) to lift it, and the readout says what
  the switch will do. Then click the switch (or press numpad Enter) to start
  a stopped guest or shut down a running one; numpad `/` cuts a running
  guest's power instead. Clicking the cover again, or numpad `*`, shuts it
  with nothing done, and so does leaving it for six seconds or selecting
  another monitor.
- Zoom: the mouse wheel over the wall closes in on the monitors under the
  pointer, three steps, and backs off again; picking a monitor goes back to
  the seat.
- Lock: the LOCK ON TARGET button on the desk, Scroll Lock, numpad `/` or a
  click on the terminal's case brings the
  view in close to the terminal's screen and holds it still; the same again
  lets go.
- Switching: type a monitor number on the numpad (two digits select at once,
  one digit after a pause or Enter), `+` and `-` for next and previous, or
  click a wall monitor. The numpad always belongs to the switcher; every
  other key goes to the guest while its console is on the desk. With no
  console there, the arrow keys move around the wall.
- Looking around: the view is yours to move and stays where you leave it.
  Drag on anything that is not a control (or drag with the right button
  anywhere) to turn the head; a finger does the same on a touch screen.
  Double-click on nothing in particular to go back to the seat's view. With
  no console on the desk, Page Down turns to the keyboard and Page Up or
  Home back to the seat.

Still to come, in order: the modelled and baked office, power control and
settings, a Debian LXC installer, then VNC screens for VMs without a serial
port.

## The bridge

A browser cannot talk to Proxmox directly: the API allows no other origin,
signs its own certificate, and a websocket cannot carry an API token. So
`server/` is a small Rust program that serves the page, keeps the token, and
passes on only what the page needs: readings of the cluster and the selected
guest's terminal. The token never reaches a browser.

- **Password.** The bridge can open consoles, so the page asks for a
  password. It is stored as an Argon2 hash, and a session is a cookie.
- **Setup card.** The first visit asks for the Proxmox address, an API token
  and a password, and for a setup code the bridge prints in its log, so that
  only whoever installed it can set it up.
- **Certificate.** A host that signs its own certificate is pinned: the card
  shows the fingerprint to compare with the one Proxmox shows, and the bridge
  then accepts that certificate and no other. A certificate from a public
  authority is verified the usual way.
- **Cluster.** Point it at any one node; it reads every node and guest the
  token may see.

The token needs `VM.Audit`, `VM.Console` and `Sys.Audit` (and `VM.PowerMgmt`
for the power control to come). On the Proxmox host:

```sh
pveum user add crt@pve
pveum role add CRTWall --privs "VM.Audit VM.Console VM.PowerMgmt Sys.Audit"
pveum acl modify / --users crt@pve --roles CRTWall
pveum user token add crt@pve wall --privsep 0
```

Settings live in one file (`/etc/proxmox-crt/config.toml` by default), which
the setup card writes and which can as well be written by hand:

```toml
listen = "0.0.0.0:8086"
password_hash = "$argon2id$..."   # from: proxmox-crt --hash-password

[proxmox]
url = "https://192.168.1.10:8006"
token_id = "crt@pve!wall"
token_secret = "..."
fingerprint = "AA:BB:..."         # leave out for a publicly signed certificate
```

The bridge serves plain http. To reach it from outside your own network, put
it behind a reverse proxy that adds TLS.

## Running it

The page alone, with a made-up cluster that runs in the page:

```sh
npm install
npm run dev     # builds on change and serves http://localhost:8086
npm run build   # production build to dist/
npm test
```

The bridge, against a real host or the mock one that comes with it:

```sh
npm run build
cd server
cargo run --example mock_pve                 # a stand-in Proxmox on https://127.0.0.1:8006
cargo run -- --config ./config.toml --client ../dist
cargo test                                   # the bridge end to end, against the mock
```

The mock prints the token and fingerprint to give the setup card; the bridge
prints the setup code.

Query parameters:

| Parameter | Effect |
|---|---|
| `?hud=1` | Draws every frame and shows the frame rate, monitor count and draw calls. |
| `?demo=1` | The made-up cluster, even where a bridge is serving the page. |
| `?guests=N` | Size of the made-up cluster (default 48). |
| `?motion=0` | No power-on and view animations, as with the browser's reduced-motion setting. |

## Layout

| Path | What it is |
|---|---|
| `client/main.js` | Page entry: snapshots in, screens out, keys and clicks. |
| `client/scene.js` | The room: wall, desk, camera, picking, the frame loop. |
| `client/gl/face.js` | The tube face shader, in a one-set form and an instanced form. |
| `client/gl/tube.js` | The desk terminal's tube, with its phosphor-state pass. |
| `client/gl/bank.js` | Many small monitors in two draw calls, one array-texture layer each. |
| `client/gl/machines.js` | The cabinets under the wall: lamps and tape reels, two draw calls. |
| `client/gl/controls.js` | The switcher box, keypad and dial on the desk. |
| `client/gl/keyboard.js` | The terminal's keyboard. |
| `client/gl/panels.js` | The racks beside the wall: clocks, status lamps, meters, scopes. |
| `client/gl/lavalamp.js` | The lava lamp. |
| `client/gl/props.js` | The logbook, mug, headset and desk lamp. |
| `client/gl/boards.js` | The big boards beyond the monitors and the signs along the top. |
| `client/gl/power.js` | What a tube does when it is switched on and off. |
| `client/gl/textgrid.js` | A grid of characters and the video signal made from it. |
| `client/gl/font9x14.js`, `client/gl/raster.js` | The character ROM and raster geometry, from terminal. |
| `client/cards.js` | What each kind of screen says. |
| `client/select.js` | The switcher's keypad logic. |
| `client/demo.js` | The made-up cluster, with a toy shell for a console. Its snapshots use Proxmox's own field names. |
| `client/bridge.js` | The real cluster, by way of the bridge: the feed of snapshots and the console sockets. |
| `client/consoles.js` | Guests' terminals: an unseen xterm.js each, drawn onto the desk tube. |
| `client/gate.js` | The setup card and the password. |
| `test/` | Unit tests for the keypad, the cards and the demo cluster. |
| `server/src/lib.rs` | The bridge: routes, the feed, the console proxy. |
| `server/src/pve.rs` | The Proxmox API client: token, pinned certificate, terminal proxy. |
| `server/src/auth.rs`, `server/src/config.rs` | Password and sessions; the settings file. |
| `server/examples/mock_pve.rs` | A stand-in Proxmox host for development and tests. |
| `server/tests/bridge.rs` | The bridge end to end, against the mock. |
