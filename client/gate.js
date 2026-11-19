// What stands between a visitor and the wall: the setup card the first
// time, and the password after that, with a second step where one is set
// up, or the way through a single sign-on provider where the bridge has
// one. The cards' parts are shared with the sign-in settings (security.js).
import { ask } from "./bridge.js";
import { passkeysWork, signWithPasskey, passkeyTrouble, NO_PASSKEYS } from "./passkey.js";

export function el(tag, attrs, children) {
  var node = document.createElement(tag);
  Object.keys(attrs || {}).forEach(function (k) {
    if (k === "text") node.textContent = attrs[k];
    else node.setAttribute(k, attrs[k]);
  });
  (children || []).forEach(function (c) {
    node.appendChild(c);
  });
  return node;
}

export function field(label, name, attrs, hint) {
  var input = el("input", Object.assign({ name: name, id: "gate-" + name, required: "" }, attrs || {}));
  var parts = [el("span", { text: label }), input];
  if (hint) parts.push(el("small", { text: hint }));
  return { row: el("label", { for: "gate-" + name }, parts), input: input };
}

// A button that reads as a line of text, for the lesser ways on from a card.
export function link(text, click) {
  var button = el("button", { type: "button", class: "gate-link", text: text });
  button.addEventListener("click", click);
  return button;
}

// The layer that is up over the wall, if one is: { host, gone }.
var up = null;

// Whether a card is up. While one is, the keyboard is its own, and no key
// is to reach the switcher or a guest's console.
export function cardOpen() {
  return !!up;
}

// A browser moves the focus where Tab or a script sends it, and whatever
// has the focus gets the keys. While a card is up this brings it back.
function keepFocus(ev) {
  if (!up || up.host.contains(ev.target)) return;
  var first = up.host.querySelector("input, button, a");
  if (first) first.focus();
}

// Puts a layer for cards over the wall, in place of any that was there.
// `gone` is called when it comes down again, whoever takes it down.
export function raise(host, gone) {
  lower();
  up = { host: host, gone: gone };
  document.body.appendChild(host);
  document.addEventListener("focusin", keepFocus);
  // A console that had the keyboard lets go of it now, not when the card's
  // first field turns up.
  var had = document.activeElement;
  if (had && had !== document.body && !host.contains(had)) had.blur();
}

export function lower() {
  if (!up) return;
  var was = up;
  up = null;
  document.removeEventListener("focusin", keepFocus);
  was.host.remove();
  if (was.gone) was.gone();
}

// Shows a card in `host`: a title, a line of explanation, rows of fields
// and a button. `submit(fail)` is called when the button is pressed, and
// calls `fail(message)` if it did not work. `after` goes under the button.
// A card with nothing to send has no `button`.
export function showCard(host, title, intro, rows, button, submit, after) {
  var error = el("p", { class: "gate-error", role: "alert" });
  var send = el("button", { type: "submit", text: button || "" });
  var form = el("form", { class: "gate-card", autocomplete: "off" }, [el("h1", { text: title }), el("p", { text: intro })].concat(rows, [error], button ? [send] : [], after || []));
  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (!button) return;
    error.textContent = "";
    send.disabled = true;
    submit(function (message) {
      error.textContent = message || "";
      send.disabled = false;
    });
  });
  host.replaceChildren(form);
  var first = form.querySelector("input, button, a");
  if (first) first.focus();
  return form;
}

var TOKEN_HELP =
  "pveum user add crt@pve\n" +
  'pveum role add CRTWall --privs "VM.Audit VM.Console VM.PowerMgmt Sys.Audit"\n' +
  "pveum acl modify / --users crt@pve --roles CRTWall\n" +
  "pveum user token add crt@pve wall --privsep 0";

// Whether the page was opened where logging in cannot work: the bridge
// marks its cookies for https alone (`state.https_only`, which it does
// when its public address is an https one), and this is plain http, where
// a browser drops such a cookie. `secure` is the browser's word on that
// (window.isSecureContext), which also holds for http://localhost.
export function wrongDoor(state, secure) {
  return state.https_only === true && secure === false;
}

// Shows the card that `state` calls for and resolves once the visitor is
// let in.
export function openGate(state) {
  return new Promise(function (resolve) {
    var gate = el("div", { id: "gate", class: "gate" });
    raise(gate);
    if (wrongDoor(state, window.isSecureContext)) {
      // A password given here would be right and still open nothing.
      showCard(
        gate,
        "PROXMOX-CRT",
        "Open this page at its https address (public_url in the bridge's settings) to sign in. Signing in does not work over plain http.",
        []
      );
      return;
    }

    function done() {
      lower();
      resolve();
    }

    function card(title, intro, rows, button, submit, after) {
      return showCard(gate, title, intro, rows, button, submit, after);
    }

    function login(message) {
      var intro = "Sign in to continue.";
      // The way in through the provider is a plain link: the bridge sends
      // the browser on to the provider, and the provider sends it back.
      var provider = state.oidc ? [el("a", { class: "gate-way", href: "api/oidc/start", text: state.oidc.label || "Sign in with single sign-on" })] : [];
      var form;
      if (state.oidc && state.password_login === false) {
        // The bridge takes no password: the provider is the only way in.
        form = card("PROXMOX-CRT", intro, provider);
      } else {
        var password = field("Password", "password", { type: "password", autocomplete: "current-password" });
        form = card(
          "PROXMOX-CRT",
          intro,
          [password.row],
          "Sign in",
          function (fail) {
            ask("login", { password: password.input.value }).then(function (r) {
              if (r.ok && r.body.second_factor) second(r.body.second_factor);
              else if (r.ok) done();
              else fail(r.body.error || "Something went wrong. Try again.");
            });
          },
          provider
        );
      }
      if (message) form.querySelector(".gate-error").textContent = message;
    }

    // The password was right and a second factor is set up. `factors`
    // says which: { totp, passkey }. `way` is the one this card is for:
    // "code" from an authenticator app, a "recovery" code in its place, or
    // a "passkey".
    function second(factors, way) {
      // The bridge says why the password is wanted again: its few minutes
      // are over, or too many codes were wrong.
      var over = "Your sign-in timed out. Enter your password again.";
      var startOver = link("Start over", function () {
        login();
      });
      if (way === "passkey" || !factors.totp) return passkey();

      var recovery = way === "recovery";
      var code = recovery
        ? field("Recovery code", "code", { type: "text", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", placeholder: "XXXX-XXXX-XXXX" })
        : field("Code", "code", { type: "text", inputmode: "numeric", autocomplete: "one-time-code", pattern: "[0-9 ]*", maxlength: "7", placeholder: "000000" });
      var after = [
        link(recovery ? "Use a code from the app" : "Use a recovery code", function () {
          second(factors, recovery ? "code" : "recovery");
        }),
        startOver,
      ];
      if (factors.passkey) {
        var other = el("button", { type: "button", class: "gate-quiet", text: "Use a passkey" });
        other.addEventListener("click", function () {
          // Pressing it is the go-ahead a browser wants before it asks
          // for a passkey, so the asking starts with it.
          second(factors, "passkey").requestSubmit();
        });
        after.unshift(other);
      }
      return card(
        "SECOND STEP",
        recovery
          ? "Enter one of your recovery codes. Each code works once."
          : "Enter the 6-digit code from your authenticator app.",
        [code.row],
        "Verify",
        function (fail) {
          ask("login/totp", { code: code.input.value }).then(function (r) {
            if (r.ok) return done();
            if (r.status === 401) return login(r.body.error || over);
            fail(r.body.error || "Something went wrong. Try again.");
          });
        },
        after
      );

      // The bridge sends a challenge, the browser has a passkey sign it,
      // and the bridge checks the signature.
      function passkey() {
        var after = [startOver];
        if (factors.totp) {
          after.unshift(
            link("Use a code from the app", function () {
              second(factors, "code");
            })
          );
        }
        return card(
          "SECOND STEP",
          "Sign in with a passkey you added earlier. Your browser will prompt you.",
          [],
          "Use a passkey",
          function (fail) {
            if (!passkeysWork()) return fail(NO_PASSKEYS);
            ask("login/passkey/start").then(function (r) {
              if (r.status === 401) return login(r.body.error || over);
              if (!r.ok) return fail(r.body.error || "Something went wrong. Try again.");
              signWithPasskey(r.body.options).then(
                function (signed) {
                  ask("login/passkey/finish", { credential: signed }).then(function (r) {
                    if (r.ok) return done();
                    if (r.status === 401) return login(r.body.error || over);
                    fail(r.body.error || "Something went wrong. Try again.");
                  });
                },
                function (e) {
                  fail(passkeyTrouble(e));
                }
              );
            });
          },
          after
        );
      }
    }

    function setup() {
      var code = field("Setup code", "code", { type: "text", spellcheck: "false", placeholder: "XXXX-XXXX" }, "Find it in the log: journalctl -u proxmox-crt");
      var url = field("Proxmox address", "url", { type: "text", spellcheck: "false", placeholder: "192.168.1.10" }, "Where your Proxmox web interface is. Port 8006 is used unless you add another.");
      var tokenId = field("API token ID", "token_id", { type: "text", spellcheck: "false", placeholder: "crt@pve!wall" });
      var secret = field("API token secret", "token_secret", { type: "password", autocomplete: "off" }, "Stored by the bridge and never sent back to the browser.");
      var password = field("Choose a password", "password", { type: "password", autocomplete: "new-password", minlength: "8" }, "At least 8 characters.");
      var again = field("Confirm password", "again", { type: "password", autocomplete: "new-password" });
      var help = el("details", {}, [
        el("summary", { text: "How to make the token" }),
        el("p", { text: "Run these in a shell on the Proxmox host. The last command shows the secret only once." }),
        el("pre", { text: TOKEN_HELP }),
      ]);
      var fingerprint = null;

      function values() {
        var v = {
          code: code.input.value,
          url: url.input.value,
          token_id: tokenId.input.value,
          token_secret: secret.input.value,
          password: password.input.value,
        };
        if (fingerprint) v.fingerprint = fingerprint;
        return v;
      }

      function send(fail) {
        if (password.input.value !== again.input.value) return fail("The passwords do not match.");
        ask("setup", values()).then(function (r) {
          if (r.ok && r.body.confirm_fingerprint) return confirm(r.body.confirm_fingerprint, r.body.url);
          if (r.ok) return done();
          fail(r.body.error || "Something went wrong. Try again.");
        });
      }

      // A host that signs its own certificate: show whose it is before
      // trusting it with the token.
      function confirm(print, host) {
        var shown = el("pre", { class: "gate-print", text: print.replace(/((?:[0-9A-F]{2}:){16})/, "$1\n") });
        card(
          "CHECK THE CERTIFICATE",
          host + " uses a self-signed certificate, which is normal for Proxmox. Check that this fingerprint matches the one under your node > System > Certificates (pve-ssl.pem). If it does, the bridge will trust only this certificate.",
          [shown],
          "They match",
          function (fail) {
            fingerprint = print;
            ask("setup", values()).then(function (r) {
              if (r.ok && !r.body.confirm_fingerprint) return done();
              fingerprint = null;
              form();
              var error = gate.querySelector(".gate-error");
              if (error) error.textContent = r.body.error || "Something went wrong. Try again.";
            });
          }
        );
      }

      function form() {
        card(
          "SET UP PROXMOX-CRT",
          "Connect to your Proxmox host. You only need to do this once.",
          [code.row, url.row, tokenId.row, secret.row, help, password.row, again.row],
          "Connect",
          send
        );
      }
      form();
    }

    if (!state.configured) setup();
    else login();
  });
}
