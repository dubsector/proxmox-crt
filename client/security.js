// The sign-in settings: a card, in the look of the gate's, where the owner
// sets up or removes what is asked for after the password (an authenticator
// app, passkeys), makes new recovery codes, sees whether single sign-on is
// on, and logs out. A quiet button in the corner of the page opens it.
import { ask } from "./bridge.js";
import { passkeysWork, makePasskey, passkeyTrouble, NO_PASSKEYS } from "./passkey.js";
import { el, field, link, showCard, raise, lower } from "./gate.js";

// A secret or a recovery code, in groups a person can keep their place in.
function grouped(text) {
  return text.replace(/(.{4})(?=.)/g, "$1 ");
}

// Puts text on the clipboard. The clipboard API needs https or localhost,
// and the bridge serves plain http on a LAN, so there is an older way
// behind it. `within` is where the older way may put what it selects: a
// card that is up keeps the focus to itself.
function copyText(text, within) {
  function oldWay() {
    var area = el("textarea", { readonly: "", style: "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0" });
    area.value = text;
    within.appendChild(area);
    area.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (e) {
      ok = false;
    }
    area.remove();
    return ok;
  }
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(function () {
      return true;
    }, oldWay);
  }
  return Promise.resolve(oldWay());
}

// options: { onClose(): the card came down and the keyboard is free again }
export function createSecurity(options) {
  var opts = options || {};
  var host = null;
  // Recovery codes are shown once: while they are, Escape does not close.
  var showing = false;
  var button = el("button", { id: "security", type: "button", text: "Sign-in settings" });
  button.addEventListener("click", open);
  document.body.appendChild(button);

  // Escape closes the card wherever the focus is: a click on the card's
  // text or beside the card leaves it on nothing at all, where a listener
  // on the card itself would not hear the key.
  function onKey(ev) {
    if (ev.key !== "Escape" || showing) return;
    ev.preventDefault();
    lower();
  }

  function open() {
    if (host) return;
    host = el("div", { id: "settings", class: "gate", role: "dialog", "aria-label": "Sign-in settings" });
    document.addEventListener("keydown", onKey, true);
    raise(host, function () {
      document.removeEventListener("keydown", onKey, true);
      host = null;
      showing = false;
      if (opts.onClose) opts.onClose();
    });
    home();
  }

  function action(text, click) {
    var b = el("button", { type: "button", class: "gate-quiet", text: text });
    b.addEventListener("click", click);
    return b;
  }

  // What is set up, and what can be done about it.
  function home() {
    showing = false;
    ask("second-factor", null, "GET").then(function (r) {
      if (!host) return;
      var rows = [];
      if (!r.ok) {
        rows.push(el("p", { class: "gate-error", text: r.body.error || "The bridge did not say what is set up." }));
      } else {
        var passkeys = r.body.passkeys || [];
        if (!r.body.totp && !passkeys.length) rows.push(el("p", { text: "The password alone opens the wall. A second step can be added to it here." }));
        if (r.body.totp) {
          var left = r.body.recovery;
          rows.push(el("p", { text: "Authenticator app: on. After the password, the wall asks for the app's code. " + left + " recovery code" + (left === 1 ? "" : "s") + " left." }));
          rows.push(action("New recovery codes", renew));
          rows.push(action("Remove the authenticator app", remove));
        } else {
          rows.push(el("p", { text: "Authenticator app: off." }));
          rows.push(action("Set up an authenticator app", enrol));
        }
        rows.push(el("p", { text: passkeys.length ? "Passkeys: after the password, the wall takes any of these." : "Passkeys: none." }));
        passkeys.forEach(function (one) {
          rows.push(
            action("Remove " + one.name + " (added " + added(one) + ")", function () {
              removePasskey(one);
            })
          );
        });
        // Where a passkey cannot be added, say why rather than offer it.
        if (!r.body.passkeys_possible) rows.push(el("p", { text: "Passkeys need the page to be reached over https at its public address: set public_url in the bridge's settings." }));
        else if (!passkeysWork()) rows.push(el("p", { text: NO_PASSKEYS }));
        else rows.push(action("Add a passkey", addPasskey));
        // Single sign-on is set up in the bridge's settings file, so here
        // it is only told.
        if (r.body.oidc) {
          rows.push(
            el("p", {
              text:
                "Single sign-on: on, through " +
                r.body.oidc.issuer +
                ". Signing in there needs no second step here: the provider asks for its own." +
                (r.body.password_login === false ? " Logging in by password is turned off, so nothing above is asked for." : ""),
            })
          );
        } else {
          rows.push(el("p", { text: "Single sign-on: off. It is turned on in the bridge's settings file." + (r.body.oidc_possible ? "" : " It needs public_url there too.") }));
        }
      }
      rows.push(action("Log out", logout));
      showCard(host, "SIGN-IN SETTINGS", "How this wall makes sure it is you.", rows, "Close", function () {
        lower();
      });
    });
  }

  function logout() {
    ask("logout").then(function () {
      // Loading the page again closes the consoles and brings the gate.
      location.reload();
    });
  }

  // A card that asks for the password again before `path` is asked to
  // change how the wall is logged in to. `then(body)` gets the answer.
  function withPassword(title, intro, button, path, method, then) {
    var password = field("Password", "password", { type: "password", autocomplete: "current-password" });
    showCard(
      host,
      title,
      intro,
      [password.row],
      button,
      function (fail) {
        ask(path, { password: password.input.value }, method).then(function (r) {
          if (!host) return;
          if (r.ok) then(r.body);
          else fail(r.body.error || "That did not work.");
        });
      },
      [link("Back", home)]
    );
  }

  function enrol() {
    withPassword(
      "SET UP AN AUTHENTICATOR APP",
      "An authenticator app on your phone shows a new six-digit code every half minute, and the wall will ask for it after the password. Enter the password to begin.",
      "Continue",
      "second-factor/totp/start",
      "POST",
      secret
    );
  }

  // The secret, for the app to take: as a QR code to scan, and as text for
  // typing by hand. Nothing is saved until a code shows the app has it.
  function secret(body) {
    var picture = el("img", { class: "gate-qr", alt: "QR code for an authenticator app", src: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(body.qr) });
    var code = field("Code from the app", "code", { type: "text", inputmode: "numeric", autocomplete: "one-time-code", pattern: "[0-9 ]*", maxlength: "7", placeholder: "000000" });
    showCard(
      host,
      "SCAN THIS WITH THE APP",
      "Scan the picture with your authenticator app, or type the secret under it into the app by hand (time-based, SHA-1, 6 digits, 30 seconds). Then enter the code the app shows.",
      [picture, el("pre", { class: "gate-print", text: grouped(body.secret) }), code.row],
      "Turn on",
      function (fail) {
        ask("second-factor/totp/confirm", { code: code.input.value }).then(function (r) {
          if (!host) return;
          if (r.ok) codes(r.body.recovery, "THE AUTHENTICATOR APP IS ON");
          else fail(r.body.error || "That did not work.");
        });
      },
      [link("Cancel", home)]
    );
  }

  // The recovery codes, which the bridge tells once and then knows only
  // well enough to recognise.
  function codes(list, title) {
    showing = true;
    var text = list.join("\n");
    var copy = link("Copy the codes", function () {
      copyText(text, host).then(function (ok) {
        copy.textContent = ok ? "Copied" : "Could not copy: select them and copy by hand";
        // The older way of copying takes the focus with it when it goes.
        if (host && host.contains(copy)) copy.focus();
      });
    });
    showCard(
      host,
      title,
      "These recovery codes are shown this once. Each one works a single time in place of the app's code, for when the phone is lost. Keep them somewhere safe that is not the phone.",
      [el("pre", { class: "gate-print gate-codes", text: text })],
      "I have saved them",
      home,
      [copy]
    );
  }

  function renew() {
    withPassword("NEW RECOVERY CODES", "This makes ten new recovery codes. The old ones stop working.", "Make new codes", "second-factor/recovery", "POST", function (body) {
      codes(body.recovery, "NEW RECOVERY CODES");
    });
  }

  function remove() {
    withPassword(
      "REMOVE THE AUTHENTICATOR APP",
      "After this the password alone opens the wall, and the recovery codes stop working.",
      "Remove",
      "second-factor/totp",
      "DELETE",
      home
    );
  }

  // The day a passkey was added, as this browser writes dates.
  function added(one) {
    return new Date(one.added * 1000).toLocaleDateString();
  }

  // Asks for the password and a name, has the browser make a passkey for
  // the bridge's challenge, and hands the bridge its public half.
  function addPasskey() {
    var password = field("Password", "password", { type: "password", autocomplete: "current-password" });
    var name = field("Name", "name", { type: "text", autocomplete: "off", maxlength: "40", placeholder: "Phone" }, "To tell this passkey from the others.");
    name.input.removeAttribute("required");
    showCard(
      host,
      "ADD A PASSKEY",
      "A passkey is kept by your phone, your computer or a security key, and the wall will take it after the password in place of a code. The browser will ask where to keep it.",
      [password.row, name.row],
      "Add",
      function (fail) {
        ask("second-factor/passkey/start", { password: password.input.value, name: name.input.value }).then(function (r) {
          if (!host) return;
          if (!r.ok) return fail(r.body.error || "That did not work.");
          makePasskey(r.body.options).then(
            function (made) {
              ask("second-factor/passkey/finish", { credential: made }).then(function (r) {
                if (!host) return;
                if (r.ok) home();
                else fail(r.body.error || "That did not work.");
              });
            },
            function (e) {
              fail(passkeyTrouble(e));
            }
          );
        });
      },
      [link("Back", home)]
    );
  }

  function removePasskey(one) {
    withPassword(
      "REMOVE A PASSKEY",
      one.name + " will no longer be taken after the password. It stays on the device that keeps it until it is deleted there too.",
      "Remove",
      "second-factor/passkey/" + encodeURIComponent(one.id),
      "DELETE",
      home
    );
  }

  return {
    open: open,
    close: lower,
  };
}
