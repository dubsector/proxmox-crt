// What a key of the desk's keyboard sends when it is clicked: the bytes a
// terminal sends for it, given what is held down with it. The keys are
// named as the browser names them (KeyboardEvent.code), with VT_ for the
// terminal's own keys that a PC keyboard has none of. A key does what its
// cap says, as on the terminal: the cap at Home says "Insert Here", so it
// inserts.
//
// Pure, so it can be tested without a page.

// The keys that type a glyph: [unshifted, shifted].
var GLYPHS = {
  Backquote: ["`", "~"],
  Digit1: ["1", "!"],
  Digit2: ["2", "@"],
  Digit3: ["3", "#"],
  Digit4: ["4", "$"],
  Digit5: ["5", "%"],
  Digit6: ["6", "^"],
  Digit7: ["7", "&"],
  Digit8: ["8", "*"],
  Digit9: ["9", "("],
  Digit0: ["0", ")"],
  Minus: ["-", "_"],
  Equal: ["=", "+"],
  BracketLeft: ["[", "{"],
  BracketRight: ["]", "}"],
  Backslash: ["\\", "|"],
  Semicolon: [";", ":"],
  Quote: ["'", '"'],
  IntlBackslash: ["<", ">"],
  Comma: [",", "<"],
  Period: [".", ">"],
  Slash: ["/", "?"],
  Space: [" ", " "],
};

// Keys whose bytes do not change with Shift. The cursor keys are here
// twice over: they depend on the cursor key mode instead.
var FIXED = {
  Backspace: "\x7f",
  Tab: "\t",
  Enter: "\r",
  Escape: "\x1b",
  // The terminal's editing keys, by the PC key they sit where.
  Insert: "\x1b[1~", // Find
  Home: "\x1b[2~", // Insert Here
  PageUp: "\x1b[3~", // Remove
  Delete: "\x1b[4~", // Select
  End: "\x1b[5~", // Prev Screen
  PageDown: "\x1b[6~", // Next Screen
  // The plain PC ones, for the grey-box keyboard's stand-ins.
  F11: "\x1b", // its cap says (ESC)
  F12: "\x08", // (BS)
  F13: "\n", // (LF)
  F6: "\x1b[17~",
  F7: "\x1b[18~",
  F8: "\x1b[19~",
  F9: "\x1b[20~",
  F10: "\x1b[21~",
  F14: "\x1b[26~",
  VT_Help: "\x1b[28~",
  VT_Do: "\x1b[29~",
  F17: "\x1b[31~",
  F18: "\x1b[32~",
  F19: "\x1b[33~",
  F20: "\x1b[34~",
  VT_PF1: "\x1bOP",
  VT_PF2: "\x1bOQ",
  VT_PF3: "\x1bOR",
  VT_PF4: "\x1bOS",
};

var ARROWS = { ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D" };

// The keys that change what the next one sends, and are let go after it
// (Lock stays until it is clicked again).
export var MODIFIERS = {
  ShiftLeft: "shift",
  ShiftRight: "shift",
  ControlLeft: "ctrl",
  ControlRight: "ctrl",
  AltLeft: "alt",
  AltRight: "alt",
  // The terminal's Compose Character key sits where Alt is, and does its job.
  VT_Compose: "alt",
  CapsLock: "lock",
};

// The bytes for `code`, or "" for a key that sends nothing (a modifier,
// or one of the terminal's own keys like Set-Up). held: { shift, ctrl,
// alt, lock, appCursor }.
export function keyBytes(code, held) {
  held = held || {};
  var out = "";
  if (ARROWS[code]) out = (held.appCursor ? "\x1bO" : "\x1b[") + ARROWS[code];
  else if (FIXED[code] !== undefined) out = FIXED[code];
  else if (/^Key[A-Z]$/.test(code)) {
    var upper = !!held.shift !== !!held.lock;
    out = upper ? code.charAt(3) : code.charAt(3).toLowerCase();
    if (held.ctrl) out = String.fromCharCode(code.charCodeAt(3) & 31);
  } else if (GLYPHS[code]) {
    out = GLYPHS[code][held.shift ? 1 : 0];
    if (held.ctrl) out = control(out);
  }
  if (out && held.alt) out = "\x1b" + out;
  return out;
}

// Ctrl with a glyph, as terminals send it: Ctrl+[ is Escape, Ctrl+Space
// and Ctrl+@ are NUL, Ctrl+? is DEL. A glyph that has no control code is
// sent as it is.
function control(ch) {
  if (ch === " " || ch === "2") return "\x00";
  if (ch === "?") return "\x7f";
  if (ch === "/") return "\x1f";
  var c = ch.charCodeAt(0);
  if (c >= 0x40 && c <= 0x5f) return String.fromCharCode(c & 31);
  return ch;
}
