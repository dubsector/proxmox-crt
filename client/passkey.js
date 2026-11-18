// Passkeys, the browser's side of them. The bridge sends what to ask the
// browser for as JSON and takes the answer as JSON; the browser wants its
// bytes as buffers and answers in buffers. This carries one into the other.

// Bytes as text, the way WebAuthn writes them: base64 with - and _ for +
// and /, and no padding.
export function toBase64url(buffer) {
  var bytes = new Uint8Array(buffer);
  var text = "";
  for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text) {
  var plain = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  var bytes = new Uint8Array(plain.length);
  for (var i = 0; i < plain.length; i++) bytes[i] = plain.charCodeAt(i);
  return bytes.buffer;
}

// A list of passkeys named by id, with the ids as buffers.
function named(list) {
  return (list || []).map(function (one) {
    return Object.assign({}, one, { id: fromBase64url(one.id) });
  });
}

// What the bridge sent for making a passkey, as navigator.credentials.create
// takes it.
export function creationOptions(sent) {
  var key = Object.assign({}, sent.publicKey);
  key.challenge = fromBase64url(key.challenge);
  key.user = Object.assign({}, key.user, { id: fromBase64url(key.user.id) });
  if (key.excludeCredentials) key.excludeCredentials = named(key.excludeCredentials);
  return { publicKey: key };
}

// The same for asking for one, as navigator.credentials.get takes it.
export function requestOptions(sent) {
  var key = Object.assign({}, sent.publicKey);
  key.challenge = fromBase64url(key.challenge);
  key.allowCredentials = named(key.allowCredentials);
  return { publicKey: key };
}

// A passkey the browser just made, as the bridge takes it.
export function madeCredential(made) {
  var response = {
    attestationObject: toBase64url(made.response.attestationObject),
    clientDataJSON: toBase64url(made.response.clientDataJSON),
  };
  if (made.response.getTransports) response.transports = made.response.getTransports();
  return { id: made.id, rawId: toBase64url(made.rawId), type: made.type, response: response };
}

// A challenge the browser had a passkey sign, as the bridge takes it.
export function signedCredential(signed) {
  var response = {
    authenticatorData: toBase64url(signed.response.authenticatorData),
    clientDataJSON: toBase64url(signed.response.clientDataJSON),
    signature: toBase64url(signed.response.signature),
    userHandle: signed.response.userHandle ? toBase64url(signed.response.userHandle) : null,
  };
  return { id: signed.id, rawId: toBase64url(signed.rawId), type: signed.type, response: response };
}

// Whether this browser can do passkeys on this page. It can only where the
// page came over https, or from the machine the browser is on.
export function passkeysWork() {
  return typeof window !== "undefined" && !!window.PublicKeyCredential && !!window.isSecureContext && !!(navigator.credentials && navigator.credentials.create);
}

export var NO_PASSKEYS = "This browser cannot use passkeys at this address. They need the page opened over https at its public address.";

// What to say when the browser did not come back with a passkey.
export function passkeyTrouble(error) {
  var name = error && error.name;
  if (name === "NotAllowedError" || name === "AbortError") return "No passkey was given. Try again when you are ready.";
  if (name === "InvalidStateError") return "That passkey is already added.";
  if (name === "SecurityError") return NO_PASSKEYS;
  return "The browser could not use a passkey" + (error && error.message ? ": " + error.message : ".");
}

// Has the browser make a passkey for what the bridge sent, and resolves
// to it as the bridge takes it.
export function makePasskey(sent) {
  return navigator.credentials.create(creationOptions(sent)).then(madeCredential);
}

// Has the browser sign the bridge's challenge with a passkey.
export function signWithPasskey(sent) {
  return navigator.credentials.get(requestOptions(sent)).then(signedCredential);
}
