# proxmox-crt

A security office for your Proxmox host: a wall of CRT monitors, one per VM or
container, cabinets of blinking lamps and turning tape reels under it, and
on the desk a terminal for whichever guest you switch to and a monitor for
each node.

It grows out of [dubsector/terminal](https://github.com/dubsector/terminal),
whose tube shader, character ROM and way of drawing text as a video signal it
reuses.

## Where it stands

The room is modelled in Blender and its light baked into light maps (see
`tools/blender/README.md`); what moves or lights up is drawn live on top.
Without the baked files the page falls back to a grey-box room. Behind it, the
page talks to a real Proxmox VE host through a small bridge, and the desk
terminal is a real terminal on whichever guest is selected. What works:

- A wall of 13 x 4 small monitors, each showing a guest's number, name, CPU
  and memory. Spare monitors stay off.
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
  blinking lamps and tape drives, with tape running from reel to reel. Each of the first few follows one node, and
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
- The terminal's keyboard on the desk, whose keys go down and stay down
  while you hold them. Its keys can be clicked too, and type into the
  console on the desk as the real ones would, by what their caps say
  (F11 is Escape, as its cap says). Shift, Ctrl and Compose (Alt) wait for
  the key clicked next, Lock stays on until it is clicked again, and the
  numpad is the switcher's, as yours is. A
  lava lamp; and what a shift leaves lying about: a logbook and pen, a mug,
  a headset and a desk lamp, which is terminal's own. Each lamp has a switch
  in its cord on the desk: click the switch to turn it on or off. The lava
  lamp's light goes out at once, but its wax goes by its heat: it sinks and settles over a couple of minutes, and takes a minute to
  get going again.
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
  with nothing done, and so does leaving it for six seconds, selecting
  another monitor or typing a monitor number: Enter after a digit selects,
  and never switches.
- Zoom: the mouse wheel closes in on whatever is under the pointer and backs
  off again, anywhere but over the desk terminal's screen and the dial. It
  stays closed in while monitors are picked.
- Lock: the LOCK ON TARGET button on the desk, Scroll Lock, numpad `/` or a
  click on the terminal's case brings the view in close to the terminal's
  screen and holds it still; the same again lets go, and so does a right
  click.
- Switching: type a monitor number on the numpad (two digits select at once,
  one digit after a pause or Enter), `+` and `-` for next and previous, or
  click a wall monitor. The numpad always belongs to the switcher; every
  other key goes to the guest while its console is on the desk. With no
  console there, the arrow keys move around the wall.
- Looking around: the view follows the pointer. It turns toward wherever in
  the window the pointer is, a little near the middle and more toward the
  edges, so the wall, the desk and the side walls are all within reach with
  nothing held down. It stops where the room's furnishing ends, and turns
  further the more it is closed in. A right click holds the view where it is, and another
  lets it follow again. Double-click on nothing in particular to go back to
  the seat's view with nothing closed in on. On a touch screen a finger
  drags the view and a tap picks. With no console on the desk, Page Down
  holds the view on the keyboard and Page Up or Home lets it go.
- A second step after the password: the six-digit code of an authenticator
  app, or one of ten recovery codes when the phone is gone, or a passkey
  kept by a phone, a computer or a security key. A small "Sign-in settings"
  button in the bottom left corner, faint until the pointer is on it, opens
  a card where the app is set up (a QR code to scan, or the secret to type
  by hand), removed again, new recovery codes are made, passkeys are added
  and removed, and where you log out. While a card is up, nothing typed
  reaches a guest and the touch keypad is out of reach under it; Escape
  closes the card.
- Single sign-on as a further way in, or the only one: with an OpenID
  Connect provider in the bridge's settings, the log-in card has a button
  that goes to the provider and comes back signed in, for the accounts the
  settings list. The sign-in settings card says whether it is on and
  through whom.

Still to come, in order: the modelled and baked office, power control and settings, a Debian LXC
installer, then VNC screens for VMs without a serial port.

## The bridge

A browser cannot talk to Proxmox directly: the API allows no other origin,
signs its own certificate, and a websocket cannot carry an API token. So
`server/` is a small Rust program that serves the page, keeps the token, and
passes on only what the page needs: readings of the cluster and the selected
guest's terminal. The token never reaches a browser.

- **Password.** The bridge can open consoles, so the page asks for a
  password. It is stored as an Argon2 hash, and a session is a cookie.
- **Second step.** With an authenticator app set up, the right password
  opens nothing by itself: it earns five minutes in which to give the app's
  code (RFC 6238: SHA-1, six digits, a new one every 30 seconds, which every
  such app reads). A code is good for its own half minute and the ones
  beside it, since clocks differ, and is never taken twice: the code that
  confirms the app when it is set up is used up by that too. Setting the app
  up gives ten recovery codes, shown once, each good for one log-in in the
  app's place; the bridge keeps only their SHA-256. Setting up or removing
  any of this takes the password again. Whoever reaches this step has the
  password, so wrong codes are counted apart from wrong passwords: a right
  password is good for three answers and is then asked for again, and
  after ten wrong codes, from whatever addresses, each further one has to
  wait, a minute at first and twice as long each time, up to an hour. The
  right code or a passkey clears the count, and so does restarting the
  bridge. Passkeys are not held up by it.
- **Sessions.** When the first second factor is set up, every session but
  the one that set it up is closed, with its feed and its consoles: they
  were opened by the password alone, which is no longer enough.
- **Passkeys.** A passkey can be the second step in the app's place, or
  beside it: after the password the bridge sends a challenge, the browser
  has the passkey sign it, and the bridge checks the signature against the
  public key it kept when the passkey was added. A challenge is good for
  five minutes and for one answer, and only for whoever it was given to. A
  passkey that counts its uses is refused if its count goes backwards, which
  is what a copy's would do. No attestation is asked for, a PIN or
  fingerprint is asked for where the authenticator has one, and up to ten
  passkeys can be added, each with a name. A passkey belongs to the name of
  a site, so passkeys need `public_url`, and the page opened at that
  address: https with a certificate the browser trusts, or
  `http://localhost`. The WebAuthn work is done by the
  [webauthn-rs](https://github.com/kanidm/webauthn-rs) library.
- **Single sign-on.** With an `[oidc]` section in the settings, the log-in
  card offers the provider as a way in. The bridge sends the browser to
  the provider (the authorization code flow, with PKCE, a state and a
  nonce), the provider sends it back with a code, and the bridge trades the
  code for an ID token. The token's signature is checked against the
  provider's published keys, and so are its issuer, its audience, its
  expiry and the nonce; a token signed with anything but the provider's
  private key is not taken. Then the account has to be on the `allow`
  list: by an email address the provider says it has verified, in any
  case of letters, or by `sub:` and the provider's own identifier for the
  account. An empty list lets nobody in. A sign-in is good for ten minutes
  and one answer, and is kept in its browser's cookie alone, sealed by the
  bridge, so any number can be away at the provider at once and none
  crowds another out. The provider's keys are read again every five
  minutes, and at once when a token turns up signed with a key the bridge
  has not seen, as after the provider changed its key. A provider that
  cannot be reached is left alone for a few seconds before it is asked
  again. A sign-in through the provider counts as complete: the
  provider is trusted to have asked for its own second step, so the bridge
  asks for no code or passkey on top. With `password_login = false` the
  password no longer logs in and the provider is the only way; the setup
  card still works the first time. The OpenID Connect work is done by the
  [openidconnect](https://github.com/ramosbugs/openidconnect-rs) library.
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
public_url = "https://crt.example.com"   # where visitors reach the page; leave out on a plain LAN
trusted_proxies = ["192.168.1.5"]        # your own reverse proxy, as an address or a range (10.0.0.0/24, fd00::/8); leave out with none

[proxmox]
url = "https://192.168.1.10:8006"
token_id = "crt@pve!wall"
token_secret = "..."
fingerprint = "AA:BB:..."         # leave out for a publicly signed certificate

# Single sign-on, written by hand. Leave the section out to have none.
[oidc]
issuer = "https://accounts.example.com"   # exactly as the provider writes it
client_id = "proxmox-crt"
client_secret = "..."                     # leave out for a public client
allow = ["you@example.com", "sub:1234567890"]   # verified email addresses, or sub: and an account's identifier
label = "Sign in with Example"            # the button's text; "Sign in with single sign-on" if left out
password_login = true                     # false: the provider is the only way in

# Written by the sign-in settings card once an authenticator app is set up.
[second_factor]
totp_secret = "JBSWY3DPEHPK3PXP..."   # base32, as the app has it
totp_last_step = 58000000             # the newest code used, so none is used twice
recovery = ["9f86d081...", "..."]     # SHA-256 of each recovery code not used yet

# One for each passkey, written when it is added.
[[second_factor.passkeys]]
id = "3f9c0a1b2d4e5f60"               # the bridge's own name for it
name = "Phone"
added = 1795000000                    # seconds since 1970
credential = '{"cred":{...}}'         # its public key and count of uses, as webauthn-rs keeps them
```

The bridge serves plain http. To reach it from outside your own network, put
it behind a reverse proxy that adds TLS, and set `public_url` to the https
address visitors then use: the cookies are marked `Secure` and travel over
nothing else. Passkeys need that address too, and so does single sign-on:
browsers allow passkeys only over https with a certificate they trust, or
on `http://localhost`, and only for a name, not a bare IP address, and a
provider sends a browser back only to the address it was told. Without it
the sign-in settings say so in place of offering a passkey, and a bridge
with an `[oidc]` section does not start. With an https `public_url`, the
page opened over plain http at the bridge's own address says to go to the
public one: a browser does not keep a `Secure` cookie there, so a log-in
would not hold. (`http://localhost`, as through an ssh tunnel, still
works.) Wrong passwords, wrong codes and passkeys that do not check out
are together limited to five a minute for each address.

Behind a proxy every connection comes from the proxy's own address, so all
visitors would share that limit, and one of them guessing would keep the
rest out. `trusted_proxies` is for that: list the address of your reverse
proxy there, or a range such as `10.0.0.0/24`, and a request that comes
from it is counted under the address the proxy says it was sent from, in
the `X-Forwarded-For` header. Each proxy adds the address it was reached
from at the right end of that header, so the bridge reads it from the
right, passes over the proxies you listed, and takes the first address
that is not one of them. What stands left of that was sent along by the
visitor and is not looked at. A request that comes from any other address
is counted under that address, whatever header it carries, and so is one
whose header names nothing usable: an entry that is no address ends the
reading there, though a port after an address is let go. Only
`X-Forwarded-For` is read, not `Forwarded` and not `X-Real-IP`. Reverse
proxies write it as a rule; some need to be told to, and one that passes
a visitor's own header on untouched must not be listed. Without the setting
the header is never read, and visitors behind a proxy share the proxy's
limit as before.

List only your own proxy. Whoever can connect from a listed address can
write any address into the header and is counted under it: with the
address of a machine you do not control in the list, or a range wider
than your proxy, its users pick the address they are counted under, a new
one for every five guesses, and only the limit for all addresses together
(sixty a minute) still holds them. An entry that is neither an address
nor a range stops the bridge from starting, and it says which. Like the
other settings written by hand it is read when the bridge starts.

The bridge writes the file itself when the setup card is filled in, when a
second factor is set up or removed, and each time a code or a passkey is
used (the newest code's step, a recovery code struck off, a passkey's
count). It reads the file first and changes only its own part, so what you
have written into it by hand meanwhile stays; comments do not, since the
file is written whole. Settings written by hand take effect when the bridge
is restarted. The file is written for its owner alone, or for its owner
and group if it was kept that way before. If root has replaced a file that
belonged to the bridge's user, the bridge's next write makes it the
bridge's own again. A write that fails is said in the bridge's log, and the
log-in that needed it is refused.

Recovery codes stand in for the authenticator app, and come and go with it.
A wall with passkeys alone has none, so add a second passkey, or the app,
as the spare. If the phone, the passkeys and the recovery codes are all
gone, whoever can get at the machine the bridge runs on can take the second
step off again:

```sh
/opt/proxmox-crt/proxmox-crt --reset-second-factor   # add --config <file> if it is not the default
systemctl restart proxmox-crt
```

That removes the `[second_factor]` section, passkeys included, and nothing
else, after which the password alone logs in. A bridge that is running
looks in the file at each log-in, so this holds at once and nothing it
writes later brings the second factors back; the restart closes the
sessions that are open.

To set up single sign-on, register the wall with your provider as a web
application (a confidential client, or a public one with PKCE) and give it
this redirect URI, which is `public_url` with `/api/oidc/callback` after it:

```
https://crt.example.com/api/oidc/callback
```

Then write the `[oidc]` section as above and restart the bridge. Some notes
that hold for most providers:

- `issuer` is the address under which the provider publishes
  `/.well-known/openid-configuration`, written exactly as that document's
  own `issuer` has it, trailing slash or none. For a provider you host
  yourself it often includes a realm, a tenant or an application name.
- The bridge asks for the `openid` and `email` scopes, and reads the email
  address from the ID token. A provider that leaves the address out of the
  ID token, or does not say that it has verified it, cannot be listed by
  address: list the account by `sub:` instead. A refused sign-in is noted
  in the bridge's log (`journalctl -u proxmox-crt`) with the `sub:` to
  put in the list, if it is your own.
- ID tokens signed with RS256, ES256, EdDSA and their kin are taken. Ones
  signed with the client secret (HS256) are not: choose a signature with
  the provider's key where there is a choice.
- The provider has to be reached over https, by the browser and by the
  bridge, which checks its certificate against the public authorities.
  Plain http is taken only for a provider on the machine itself.
- Whoever is on the list has the whole wall, consoles included: single
  sign-on decides who comes in, not what they may do.

If `password_login = false` and the provider is gone, or no longer lets you
through, the password can be turned back on from the machine the bridge
runs on:

```sh
/opt/proxmox-crt/proxmox-crt --enable-password-login   # add --config <file> if it is not the default
systemctl restart proxmox-crt
```

That sets `password_login = true` and changes nothing else. A bridge that
is running goes on refusing the password until it is restarted, and leaves
the line as it is whatever it writes meanwhile. A second factor that was
set up before is asked for again after the password.

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
| `client/gl/keyboard.js` | The terminal's keyboard, in grey-box form. |
| `client/keymap.js` | What a click on a key of the desk's keyboard sends to the console. |
| `client/gl/panels.js` | The racks beside the wall: clocks, status lamps, meters, scopes. |
| `client/gl/lavalamp.js` | The lava lamp. |
| `client/gl/props.js` | The logbook, mug, headset and desk lamp. |
| `client/gl/lamp-model.js` | The desk lamp's shape, taken from terminal's scene by `tools/extract-lamp.mjs`. |
| `client/gl/cordswitch.js` | The rocker switch in a lamp's cord. |
| `client/gl/boards.js` | The big boards beyond the monitors and the signs along the top. |
| `client/gl/power.js` | What a tube does when it is switched on and off. |
| `client/gl/textgrid.js` | A grid of characters and the video signal made from it. |
| `client/gl/font9x14.js`, `client/gl/raster.js` | The character ROM and raster geometry, from terminal. |
| `client/cards.js` | What each kind of screen says. |
| `client/select.js` | The switcher's keypad logic. |
| `client/demo.js` | The made-up cluster, with a toy shell for a console. Its snapshots use Proxmox's own field names. |
| `client/bridge.js` | The real cluster, by way of the bridge: the feed of snapshots and the console sockets. |
| `client/consoles.js` | Guests' terminals: an unseen xterm.js each, drawn onto the desk tube. |
| `client/gate.js` | The setup card, the password and the second step after it, and the provider's button. |
| `client/security.js` | The sign-in settings card and the corner button that opens it. |
| `client/passkey.js` | Passkeys in the browser: the bridge's JSON to the browser's buffers and back. |
| `test/` | Unit tests for the keypad, the cards, the demo cluster, the passkey conversions, the gate and what the desk's keyboard sends. |
| `server/src/lib.rs` | The bridge: routes, the feed, the console proxy. |
| `server/src/pve.rs` | The Proxmox API client: token, pinned certificate, terminal proxy. |
| `server/src/auth.rs`, `server/src/config.rs` | Password and sessions; the settings file. |
| `server/src/totp.rs` | Authenticator app codes, their QR code, recovery codes. |
| `server/src/second_factor.rs` | The second step of logging in by code, and the routes that set it up and remove it. |
| `server/src/passkey.rs` | The second step by passkey, and the routes that add and remove passkeys. |
| `server/src/oidc.rs` | Single sign-on: the trip to the provider and back, and who is let in. |
| `server/src/visitor.rs` | Whose address a request is counted under behind a reverse proxy: `trusted_proxies` and `X-Forwarded-For`. |
| `server/examples/mock_pve.rs` | A stand-in Proxmox host for development and tests. |
| `server/tests/bridge.rs` | The bridge end to end, against the mock. |
