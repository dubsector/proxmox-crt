import { test } from "node:test";
import assert from "node:assert/strict";
import { toBase64url, fromBase64url, creationOptions, requestOptions, madeCredential, signedCredential, passkeysWork, passkeyTrouble, NO_PASSKEYS } from "../client/passkey.js";

function bytes(list) {
  return new Uint8Array(list).buffer;
}

function list(buffer) {
  return Array.from(new Uint8Array(buffer));
}

test("bytes go to text and back the way WebAuthn writes them", function () {
  assert.equal(toBase64url(bytes([])), "");
  assert.equal(toBase64url(bytes([1, 2, 3])), "AQID");
  // No padding, and - and _ where base64 has + and /.
  assert.equal(toBase64url(bytes([251, 255, 254])), "-__-");
  assert.equal(toBase64url(bytes([251, 255])), "-_8");
  assert.deepEqual(list(fromBase64url("-_8")), [251, 255]);
  assert.deepEqual(list(fromBase64url("AQID")), [1, 2, 3]);
  var all = [];
  for (var i = 0; i < 256; i++) all.push(i);
  assert.deepEqual(list(fromBase64url(toBase64url(bytes(all)))), all);
  // A view of part of a buffer is its own bytes only.
  assert.equal(toBase64url(new Uint8Array(bytes([9, 1, 2, 3, 9]), 1, 3)), "AQID");
});

test("what the bridge asks for reaches the browser with its bytes as buffers", function () {
  var sent = {
    publicKey: {
      rp: { name: "proxmox-crt", id: "crt.example.com" },
      user: { id: "AAAAAAAAAAAAAAAAAAAABQ", name: "owner", displayName: "proxmox-crt" },
      challenge: "AQID",
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      timeout: 300000,
      excludeCredentials: [{ type: "public-key", id: "-_8" }],
      authenticatorSelection: { residentKey: "preferred", requireResidentKey: false, userVerification: "preferred" },
      attestation: "none",
    },
  };
  var options = creationOptions(sent).publicKey;
  assert.deepEqual(list(options.challenge), [1, 2, 3]);
  assert.equal(options.user.id.byteLength, 16);
  assert.equal(options.user.name, "owner");
  assert.deepEqual(list(options.excludeCredentials[0].id), [251, 255]);
  assert.equal(options.excludeCredentials[0].type, "public-key");
  assert.equal(options.authenticatorSelection.residentKey, "preferred");
  assert.equal(options.rp.id, "crt.example.com");
  // What was sent is left as it was.
  assert.equal(sent.publicKey.challenge, "AQID");
  assert.equal(sent.publicKey.user.id, "AAAAAAAAAAAAAAAAAAAABQ");

  delete sent.publicKey.excludeCredentials;
  assert.equal(creationOptions(sent).publicKey.excludeCredentials, undefined);

  var asked = requestOptions({
    publicKey: { challenge: "AQID", timeout: 300000, rpId: "crt.example.com", allowCredentials: [{ type: "public-key", id: "-_8" }], userVerification: "preferred" },
  }).publicKey;
  assert.deepEqual(list(asked.challenge), [1, 2, 3]);
  assert.deepEqual(list(asked.allowCredentials[0].id), [251, 255]);
  assert.equal(asked.rpId, "crt.example.com");
});

test("what the browser answers reaches the bridge as text", function () {
  var made = madeCredential({
    id: "-_8",
    rawId: bytes([251, 255]),
    type: "public-key",
    response: {
      attestationObject: bytes([1, 2, 3]),
      clientDataJSON: bytes([123, 125]),
      getTransports: function () {
        return ["internal"];
      },
    },
  });
  assert.deepEqual(made, {
    id: "-_8",
    rawId: "-_8",
    type: "public-key",
    response: { attestationObject: "AQID", clientDataJSON: "e30", transports: ["internal"] },
  });
  // An older browser does not say how the passkey is reached.
  var plain = madeCredential({ id: "AQID", rawId: bytes([1, 2, 3]), type: "public-key", response: { attestationObject: bytes([1]), clientDataJSON: bytes([2]) } });
  assert.equal("transports" in plain.response, false);

  var response = { authenticatorData: bytes([1, 2, 3]), clientDataJSON: bytes([123, 125]), signature: bytes([251, 255]), userHandle: null };
  var signed = signedCredential({ id: "-_8", rawId: bytes([251, 255]), type: "public-key", response: response });
  assert.deepEqual(signed, {
    id: "-_8",
    rawId: "-_8",
    type: "public-key",
    response: { authenticatorData: "AQID", clientDataJSON: "e30", signature: "-_8", userHandle: null },
  });
  response.userHandle = bytes([5]);
  assert.equal(signedCredential({ id: "-_8", rawId: bytes([251, 255]), type: "public-key", response: response }).response.userHandle, "BQ");
  // It all goes over the wire as JSON.
  assert.equal(JSON.parse(JSON.stringify({ credential: signed })).credential.response.signature, "-_8");
});

test("trouble with a passkey is said in plain words", function () {
  // Nothing to ask in a place with no browser.
  assert.equal(passkeysWork(), false);
  assert.match(passkeyTrouble({ name: "NotAllowedError", message: "The operation either timed out or was not allowed." }), /^No passkey was given/);
  assert.equal(passkeyTrouble({ name: "InvalidStateError" }), "That passkey is already added.");
  assert.equal(passkeyTrouble({ name: "SecurityError" }), NO_PASSKEYS);
  assert.equal(passkeyTrouble({ name: "UnknownError", message: "it broke" }), "The browser could not use a passkey: it broke");
  assert.equal(passkeyTrouble(null), "The browser could not use a passkey.");
});
