# The bridge

A browser cannot talk to Proxmox directly: the API allows no other origin,
signs its own certificate, and a websocket cannot carry an API token. So
`server/` is a small Rust program that serves the page, keeps the token, and
passes on only what the page needs: readings of the cluster and the selected
guest's terminal. The token never reaches a browser.

- **Password.** The bridge can open consoles, so the page asks for a
  password. It is stored as an Argon2 hash, and a session is a cookie.
  "Change password" in the sign-in settings takes the current password and
  a new one, and signs out every other session.
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
- **Cluster.** Point it at any one node; it reads every node, guest and
  storage the token may see, the latest tasks and the quorum.

## The API token

The token needs `VM.Audit`, `VM.Console` and `Sys.Audit`, `VM.PowerMgmt`
for the power switch, and `Datastore.Audit` for the room's storage board and
lamps. On the Proxmox host:

```sh
pveum user add crt@pve
pveum role add CRTWall --privs "VM.Audit VM.Console VM.PowerMgmt Sys.Audit Datastore.Audit"
pveum acl modify / --users crt@pve --roles CRTWall
pveum user token add crt@pve wall --privsep 0
```

A role made before the storage board has no `Datastore.Audit`; the board then
lists no storage, and nothing else minds. To add it:

```sh
pveum role modify CRTWall --privs Datastore.Audit --append 1
```

Besides the nodes and guests, each reading takes the storage from the same
listing, each node's status (load average, I/O wait, swap), the cluster's
latest tasks, its quorum and the host's time of day. Whatever the token may not read is shown in the
room as not known: dark lamps, needles at rest, dashes on a clock.

## Settings

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

## Behind a reverse proxy

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

## How the file is written

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

## When the second step is lost

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

## Single sign-on

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
