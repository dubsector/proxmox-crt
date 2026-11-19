// The sign-in settings: a card, in the look of the gate's, where the owner
// sets up or removes what is asked for after the password (an authenticator
// app, passkeys), makes new recovery codes, changes the password, sees
// whether single sign-on is on, and logs out. A quiet button in the corner of the page opens it.
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
        rows.push(el("p", { class: "gate-error", text: r.body.error || "Could not load your sign-in settings." }));
      } else {
        var passkeys = r.body.passkeys || [];
        if (!r.body.totp && !passkeys.length) rows.push(el("p", { text: "Only a password is needed to sign in. You can add a second step here." }));
        if (r.body.totp) {
          var left = r.body.recovery;
          rows.push(el("p", { text: "Authenticator app: on. You are asked for a code after your password. " + left + " recovery code" + (left === 1 ? "" : "s") + " left." }));
          rows.push(action("New recovery codes", renew));
          rows.push(action("Remove the authenticator app", remove));
        } else {
          rows.push(el("p", { text: "Authenticator app: off." }));
          rows.push(action("Set up an authenticator app", enrol));
        }
        rows.push(el("p", { text: passkeys.length ? "Passkeys: any of these can be used after your password." : "Passkeys: none." }));
        passkeys.forEach(function (one) {
          rows.push(
            action("Remove " + one.name + " (added " + added(one) + ")", function () {
              removePasskey(one);
            })
          );
        });
        // Where a passkey cannot be added, say why rather than offer it.
        if (!r.body.passkeys_possible) rows.push(el("p", { text: "Passkeys need this page opened at its https address. Set public_url in the bridge's settings." }));
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
                ". No second step is asked for here, since the provider handles its own." +
                (r.body.password_login === false ? " Password sign-in is turned off, so the settings above are not used." : ""),
            })
          );
        } else {
          rows.push(el("p", { text: "Single sign-on: off. Turn it on in the bridge's settings file." + (r.body.oidc_possible ? "" : " It needs public_url there too.") }));
        }
      }
      rows.push(action("Change password", changePassword));
      rows.push(action("Log out", logout));
      showCard(host, "SIGN-IN SETTINGS", "How you sign in to this page.", rows, "Close", function () {
        lower();
      });
    });
  }

  // The old password, then the new one twice. Every other session is
  // closed by the bridge; this one stays open.
  function changePassword() {
    var password = field("Current password", "password", { type: "password", autocomplete: "current-password" });
    var next = field("New password", "new_password", { type: "password", autocomplete: "new-password", minlength: "8" }, "At least 8 characters.");
    var again = field("Confirm new password", "again", { type: "password", autocomplete: "new-password" });
    showCard(
      host,
      "CHANGE PASSWORD",
      "Anywhere else signed in to this page will be signed out.",
      [password.row, next.row, again.row],
      "Change password",
      function (fail) {
        if (next.input.value !== again.input.value) return fail("The new passwords do not match.");
        ask("password", { password: password.input.value, new_password: next.input.value }).then(function (r) {
          if (!host) return;
          if (r.ok) showCard(host, "PASSWORD CHANGED", "Your new password is saved. Anywhere else signed in has been signed out.", [], "Done", home);
          else fail(r.body.error || "Something went wrong. Try again.");
        });
      },
      [link("Back", home)]
    );
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
          else fail(r.body.error || "Something went wrong. Try again.");
        });
      },
      [link("Back", home)]
    );
  }

  function enrol() {
    withPassword(
      "SET UP AN AUTHENTICATOR APP",
      "An authenticator app on your phone shows a new 6-digit code every 30 seconds. You will enter it after your password. Enter your password to begin.",
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
      "Scan the QR code with your authenticator app, or enter the secret below it by hand (time-based, SHA-1, 6 digits, 30 seconds). Then enter the code the app shows.",
      [picture, el("pre", { class: "gate-print", text: grouped(body.secret) }), code.row],
      "Turn on",
      function (fail) {
        ask("second-factor/totp/confirm", { code: code.input.value }).then(function (r) {
          if (!host) return;
          if (r.ok) codes(r.body.recovery, "THE AUTHENTICATOR APP IS ON");
          else fail(r.body.error || "Something went wrong. Try again.");
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
        copy.textContent = ok ? "Copied" : "Could not copy. Select the codes and copy them by hand.";
        // The older way of copying takes the focus with it when it goes.
        if (host && host.contains(copy)) copy.focus();
      });
    });
    showCard(
      host,
      title,
      "These recovery codes are shown only once. Each one can be used once instead of an app code, in case you lose your phone. Keep them somewhere safe, not on your phone.",
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
      "After this, only your password is needed to sign in, and your recovery codes stop working.",
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
    var name = field("Name", "name", { type: "text", autocomplete: "off", maxlength: "40", placeholder: "Phone" }, "Helps you tell your passkeys apart.");
    name.input.removeAttribute("required");
    showCard(
      host,
      "ADD A PASSKEY",
      "A passkey is stored on your phone, computer or security key, and can be used after your password instead of a code. Your browser will ask where to save it.",
      [password.row, name.row],
      "Add",
      function (fail) {
        ask("second-factor/passkey/start", { password: password.input.value, name: name.input.value }).then(function (r) {
          if (!host) return;
          if (!r.ok) return fail(r.body.error || "Something went wrong. Try again.");
          makePasskey(r.body.options).then(
            function (made) {
              ask("second-factor/passkey/finish", { credential: made }).then(function (r) {
                if (!host) return;
                if (r.ok) home();
                else fail(r.body.error || "Something went wrong. Try again.");
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
      one.name + " can no longer be used to sign in. It stays on the device that holds it until you delete it there too.",
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
