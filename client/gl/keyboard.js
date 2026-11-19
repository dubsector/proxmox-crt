// The terminal's keyboard, on the desk in front of it: a case and its
// keys, which go down as the real ones are typed on. Plain shapes, like
// the rest of the grey-box room.
//
// All the keys are one draw call and their legends one more.
import {
  Group,
  Mesh,
  BoxGeometry,
  PlaneGeometry,
  InstancedMesh,
  MeshStandardMaterial,
  MeshBasicMaterial,
  CanvasTexture,
  SRGBColorSpace,
  Matrix4,
  Vector3,
  Quaternion,
  Color,
} from "three";

// Each row, far row first: [what the browser calls the key, its legend,
// its width in keys]. A row is 15 keys wide.
export var KEYBOARD = [
  [
    ["Escape", "ESC", 1],
    ["Digit1", "1", 1],
    ["Digit2", "2", 1],
    ["Digit3", "3", 1],
    ["Digit4", "4", 1],
    ["Digit5", "5", 1],
    ["Digit6", "6", 1],
    ["Digit7", "7", 1],
    ["Digit8", "8", 1],
    ["Digit9", "9", 1],
    ["Digit0", "0", 1],
    ["Minus", "-", 1],
    ["Equal", "=", 1],
    ["Backspace", "DEL", 2],
  ],
  [
    ["Tab", "TAB", 1.5],
    ["KeyQ", "Q", 1],
    ["KeyW", "W", 1],
    ["KeyE", "E", 1],
    ["KeyR", "R", 1],
    ["KeyT", "T", 1],
    ["KeyY", "Y", 1],
    ["KeyU", "U", 1],
    ["KeyI", "I", 1],
    ["KeyO", "O", 1],
    ["KeyP", "P", 1],
    ["BracketLeft", "[", 1],
    ["BracketRight", "]", 1],
    ["Backslash", "\\", 1.5],
  ],
  [
    ["CapsLock", "CAPS", 1.75],
    ["KeyA", "A", 1],
    ["KeyS", "S", 1],
    ["KeyD", "D", 1],
    ["KeyF", "F", 1],
    ["KeyG", "G", 1],
    ["KeyH", "H", 1],
    ["KeyJ", "J", 1],
    ["KeyK", "K", 1],
    ["KeyL", "L", 1],
    ["Semicolon", ";", 1],
    ["Quote", "'", 1],
    ["Enter", "RETURN", 2.25],
  ],
  [
    ["ShiftLeft", "SHIFT", 2.25],
    ["KeyZ", "Z", 1],
    ["KeyX", "X", 1],
    ["KeyC", "C", 1],
    ["KeyV", "V", 1],
    ["KeyB", "B", 1],
    ["KeyN", "N", 1],
    ["KeyM", "M", 1],
    ["Comma", ",", 1],
    ["Period", ".", 1],
    ["Slash", "/", 1],
    ["ShiftRight", "SHIFT", 2.75],
  ],
  [
    ["ControlLeft", "CTRL", 1.5],
    ["MetaLeft", "", 1.25],
    ["AltLeft", "ALT", 1.25],
    ["Space", "", 6.5],
    ["AltRight", "ALT", 1.25],
    ["MetaRight", "", 1.25],
    ["ControlRight", "CTRL", 2],
  ],
];
// Keys this keyboard has no cap for go down on the nearest thing to them.
var STAND_INS = { Backquote: "Escape", Delete: "Backspace", NumpadEnter: null };

var UNITS = 15;
var KEY_UP = new Color(0.8, 0.77, 0.67);
var KEY_DARK = new Color(0.36, 0.35, 0.32);
var KEY_LIT = new Color(1.0, 0.86, 0.5);
var KEY_FLASH_S = 0.16;

function legendTexture(keys) {
  if (typeof document === "undefined") return null;
  var cell = 96;
  var canvas = document.createElement("canvas");
  canvas.width = cell * UNITS;
  canvas.height = cell * KEYBOARD.length;
  var ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  keys.forEach(function (k) {
    if (!k.legend) return;
    var word = k.legend.length > 1;
    ctx.fillStyle = word ? "#e9e4d2" : "#17150f";
    ctx.font = "bold " + (word ? 22 : 44) + "px ui-monospace, Menlo, Consolas, monospace";
    ctx.fillText(k.legend, (k.u + k.w / 2) * cell, (k.r + 0.5) * cell + 2);
  });
  var texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

// options: { x, y, z: the middle of the case's underside, width: of the
// case, material: what the case is made of }
export function createKeyboard(options) {
  var group = new Group();
  group.position.set(options.x, options.y, options.z);
  var owned = [];

  var pitch = (options.width - 0.4) / UNITS;
  var deep = KEYBOARD.length * pitch;
  var CASE_H = 0.4;
  var KEY_H = 0.2;

  var caseGeometry = new BoxGeometry(options.width, CASE_H, deep + 0.5);
  var caseMesh = new Mesh(caseGeometry, options.material);
  caseMesh.position.y = CASE_H / 2;
  group.add(caseMesh);
  owned.push(caseGeometry);

  var keys = [];
  var byCode = {};
  KEYBOARD.forEach(function (row, r) {
    var u = 0;
    row.forEach(function (key) {
      byCode[key[0]] = keys.length;
      keys.push({ code: key[0], legend: key[1], w: key[2], u: u, r: r });
      u += key[2];
    });
  });

  var keyGeometry = new BoxGeometry(1, KEY_H, 1);
  var keyMaterial = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
  var caps = new InstancedMesh(keyGeometry, keyMaterial, keys.length);
  owned.push(keyGeometry, keyMaterial);
  var matrix = new Matrix4();
  var at = new Vector3();
  var size = new Vector3();
  var flat = new Quaternion();
  var tint = new Color();
  var glow = new Float32Array(keys.length);
  function place(i) {
    var k = keys[i];
    // A key that was just pressed is down a little.
    at.set((k.u + k.w / 2 - UNITS / 2) * pitch, CASE_H + KEY_H / 2 - 0.02 - 0.08 * glow[i], (k.r + 0.5 - KEYBOARD.length / 2) * pitch);
    size.set(k.w * pitch - 0.07, 1, pitch - 0.07);
    caps.setMatrixAt(i, matrix.compose(at, flat, size));
    // The keys that are words are the dark ones, as on a terminal's keyboard.
    caps.setColorAt(i, tint.copy(k.legend.length > 1 ? KEY_DARK : KEY_UP).lerp(KEY_LIT, glow[i]));
  }
  for (var i = 0; i < keys.length; i++) place(i);
  group.add(caps);

  var legends = legendTexture(keys);
  if (legends) {
    var legendGeometry = new PlaneGeometry(UNITS * pitch, deep);
    var legendMaterial = new MeshBasicMaterial({ map: legends, transparent: true, depthWrite: false });
    var sheet = new Mesh(legendGeometry, legendMaterial);
    sheet.rotation.x = -Math.PI / 2;
    sheet.position.y = CASE_H + KEY_H - 0.015;
    group.add(sheet);
    owned.push(legendGeometry, legendMaterial, legends);
  }

  var held = {};
  return {
    group: group,
    // What a click can land on, and the code of the key it landed on.
    pickables: [caps],
    codeAt: function (hit) {
      if (hit.object !== caps || hit.instanceId === undefined) return undefined;
      return keys[hit.instanceId].code;
    },
    // A key held down, or let go. True if the keyboard has that key.
    hold: function (code, down) {
      if (STAND_INS[code]) code = STAND_INS[code];
      var i = byCode[code];
      if (i === undefined) return false;
      held[i] = !!down;
      glow[i] = 1;
      // Let go, it rises as a struck key does.
      return true;
    },
    // Shows a key going down. True if the keyboard has that key.
    press: function (code) {
      if (STAND_INS[code]) code = STAND_INS[code];
      var i = byCode[code];
      if (i === undefined) return false;
      glow[i] = 1;
      return true;
    },
    // Moves the keys on by dt seconds. True while any is moving.
    update: function (dt) {
      var moving = false;
      for (var i = 0; i < keys.length; i++) {
        // A held key stays down and lit, and needs no more frames.
        if (glow[i] <= 0 || held[i] === "placed") continue;
        if (held[i]) held[i] = "placed";
        else glow[i] = Math.max(0, glow[i] - dt / KEY_FLASH_S);
        place(i);
        moving = true;
      }
      if (moving) {
        caps.instanceMatrix.needsUpdate = true;
        caps.instanceColor.needsUpdate = true;
      }
      return moving;
    },
    dispose: function () {
      owned.forEach(function (o) {
        o.dispose();
      });
      caps.dispose();
    },
  };
}
