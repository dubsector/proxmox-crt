// What stands between a visitor and the wall: the setup card the first
// time, and the password after that.
import { ask } from "./bridge.js";

function el(tag, attrs, children) {
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

function field(label, name, attrs, hint) {
  var input = el("input", Object.assign({ name: name, id: "gate-" + name, required: "" }, attrs || {}));
  var parts = [el("span", { text: label }), input];
  if (hint) parts.push(el("small", { text: hint }));
  return { row: el("label", { for: "gate-" + name }, parts), input: input };
}

var TOKEN_HELP =
  "pveum user add crt@pve\n" +
  'pveum role add CRTWall --privs "VM.Audit VM.Console VM.PowerMgmt Sys.Audit"\n' +
  "pveum acl modify / --users crt@pve --roles CRTWall\n" +
  "pveum user token add crt@pve wall --privsep 0";

// Shows the card that `state` calls for and resolves once the visitor is
// let in.
export function openGate(state) {
  return new Promise(function (resolve) {
    var gate = el("div", { id: "gate" });
    document.body.appendChild(gate);

    function done() {
      gate.remove();
      resolve();
    }

    function card(title, intro, rows, button, submit) {
      var error = el("p", { class: "gate-error", role: "alert" });
      var send = el("button", { type: "submit", text: button });
      var form = el("form", { class: "gate-card", autocomplete: "off" }, [el("h1", { text: title }), el("p", { text: intro })].concat(rows, [error, send]));
      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        error.textContent = "";
        send.disabled = true;
        submit(function (message) {
          error.textContent = message || "";
          send.disabled = false;
        });
      });
      gate.replaceChildren(form);
      var first = form.querySelector("input");
      if (first) first.focus();
    }

    function login() {
      var password = field("Password", "password", { type: "password", autocomplete: "current-password" });
      card("PROXMOX-CRT", "This wall can open consoles on your guests, so it asks who is there.", [password.row], "Log in", function (fail) {
        ask("login", { password: password.input.value }).then(function (r) {
          if (r.ok) done();
          else fail(r.body.error || "That did not work.");
        });
      });
    }

    function setup() {
      var code = field("Setup code", "code", { type: "text", spellcheck: "false", placeholder: "XXXX-XXXX" }, "Printed in the bridge's log: journalctl -u proxmox-crt");
      var url = field("Proxmox address", "url", { type: "text", spellcheck: "false", placeholder: "192.168.1.10" }, "The host the web interface is on. Port 8006 unless you say otherwise.");
      var tokenId = field("API token ID", "token_id", { type: "text", spellcheck: "false", placeholder: "crt@pve!wall" });
      var secret = field("API token secret", "token_secret", { type: "password", autocomplete: "off" }, "Kept by the bridge. It never comes back to a browser.");
      var password = field("Password for this page", "password", { type: "password", autocomplete: "new-password", minlength: "8" }, "At least 8 characters.");
      var again = field("Password again", "again", { type: "password", autocomplete: "new-password" });
      var help = el("details", {}, [
        el("summary", { text: "How to make the token" }),
        el("p", { text: "In a shell on the Proxmox host. The last command prints the secret, once." }),
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
        if (password.input.value !== again.input.value) return fail("The two passwords differ.");
        ask("setup", values()).then(function (r) {
          if (r.ok && r.body.confirm_fingerprint) return confirm(r.body.confirm_fingerprint, r.body.url);
          if (r.ok) return done();
          fail(r.body.error || "That did not work.");
        });
      }

      // A host that signs its own certificate: show whose it is before
      // trusting it with the token.
      function confirm(print, host) {
        var shown = el("pre", { class: "gate-print", text: print.replace(/((?:[0-9A-F]{2}:){16})/, "$1\n") });
        card(
          "CHECK THE CERTIFICATE",
          host + " signs its own certificate, as Proxmox does out of the box. Compare this fingerprint with the one Proxmox shows under your node, System, Certificates (pve-ssl.pem). If they match, the bridge will talk to that certificate and no other.",
          [shown],
          "They match",
          function (fail) {
            fingerprint = print;
            ask("setup", values()).then(function (r) {
              if (r.ok && !r.body.confirm_fingerprint) return done();
              fingerprint = null;
              form();
              var error = gate.querySelector(".gate-error");
              if (error) error.textContent = r.body.error || "That did not work.";
            });
          }
        );
      }

      function form() {
        card(
          "SET UP PROXMOX-CRT",
          "Point the wall at your Proxmox host. This is asked once and saved by the bridge.",
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
