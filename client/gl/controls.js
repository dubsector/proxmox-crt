// What the monitors are switched with: the switcher box beside the
// terminal, with its two-digit readout, a lamp for the selected guest's
// power and the guarded switch that starts and stops it; a keypad on the
// desk; a dial; and the lock on target button. Plain shapes, like the rest
// of the grey-box room. The keypad and dial can be clicked, and they move
// when the real keyboard does the same thing.
import {
  Group,
  Mesh,
  BoxGeometry,
  PlaneGeometry,
  CylinderGeometry,
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

// Which of a digit's seven segments (a top, b and c right, d bottom, e and
// f left, g middle) each character lights.
export var SEGMENTS = {
  0: "abcdef",
  1: "bc",
  2: "abged",
  3: "abgcd",
  4: "fgbc",
  5: "afgcd",
  6: "afgedc",
  7: "abc",
  8: "abcdefg",
  9: "abfgcd",
  "-": "g",
  _: "d",
  " ": "",
};
export var SEGMENT_ORDER = "abcdefg";

var LED_ON = new Color(1.0, 0.17, 0.07);
var LED_OFF = new Color(0.045, 0.008, 0.005);
var LOCK_ON = new Color(1.0, 0.13, 0.06);
var LOCK_OFF = new Color(0.3, 0.035, 0.02);
var KEY_UP = new Color(0.62, 0.6, 0.53);
var KEY_LIT = new Color(1.0, 0.86, 0.5);
var POWER = {
  on: new Color(0.25, 1.0, 0.4),
  off: new Color(1.0, 0.2, 0.08),
  none: new Color(0.05, 0.06, 0.05),
};

// The keypad, far row first, as a numeric pad is laid out. null is a gap.
export var KEYPAD = [
  ["Numpad7", "Numpad8", "Numpad9", "NumpadSubtract"],
  ["Numpad4", "Numpad5", "Numpad6", "NumpadAdd"],
  ["Numpad1", "Numpad2", "Numpad3", "NumpadEnter"],
  ["Numpad0", "NumpadDecimal", null, null],
];
var LEGENDS = {
  NumpadSubtract: "−",
  NumpadAdd: "+",
  NumpadEnter: "↵",
  NumpadDecimal: ".",
};
var KEY_PITCH = 0.58;
var KEY_SIZE = 0.5;
var KEY_FLASH_S = 0.22;
// The dial clicks round a twelfth of a turn for each monitor it steps.
var DIAL_STEP = Math.PI / 6;

function legendTexture() {
  if (typeof document === "undefined") return null;
  var cell = 64;
  var canvas = document.createElement("canvas");
  canvas.width = cell * 4;
  canvas.height = cell * 4;
  var ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#17150f";
  ctx.font = "bold 38px ui-monospace, Menlo, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  KEYPAD.forEach(function (row, r) {
    row.forEach(function (code, c) {
      if (!code) return;
      ctx.fillText(LEGENDS[code] || code.slice(-1), (c + 0.5) * cell, (r + 0.5) * cell + 2);
    });
  });
  var texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function lockTexture() {
  if (typeof document === "undefined") return null;
  var canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 160;
  var ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#16181a";
  ctx.fillRect(0, 0, 512, 160);
  ctx.strokeStyle = "#d8b21c";
  ctx.lineWidth = 6;
  ctx.strokeRect(8, 8, 496, 144);
  ctx.fillStyle = "#e9e4d2";
  ctx.font = "bold 58px ui-monospace, Menlo, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("LOCK ON TARGET", 256, 84, 460);
  var texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

// options: { deskY: height of the desk top, box: { x, z, turn } where the
// switcher box stands, keypad: { x, z }, dial: { x, z }, lock: { x, z, turn }
// where the lock on target button is }
export function createControls(options) {
  var group = new Group();
  var owned = [];
  var deskY = options.deskY;

  var steel = new MeshStandardMaterial({ color: 0x23272b, roughness: 0.55, metalness: 0.35 });
  var dark = new MeshStandardMaterial({ color: 0x0b0c0d, roughness: 0.4 });
  var plate = new MeshStandardMaterial({ color: 0x2c3035, roughness: 0.6, metalness: 0.2 });
  var cream = new MeshStandardMaterial({ color: 0xd9d3bd, roughness: 0.6 });
  var chrome = new MeshStandardMaterial({ color: 0xc9ccd0, roughness: 0.25, metalness: 0.85 });
  owned.push(steel, dark, plate, cream, chrome);

  function box(parent, w, h, d, x, y, z, material) {
    var m = new Mesh(new BoxGeometry(w, h, d), material);
    m.position.set(x, y, z);
    owned.push(m.geometry);
    parent.add(m);
    return m;
  }

  var matrix = new Matrix4();
  var at = new Vector3();
  var size = new Vector3();
  var flat = new Quaternion();

  // --- the switcher box ----------------------------------------------------
  var BOX = { w: 3.3, h: 1.9, d: 2.2 };
  var switcher = new Group();
  switcher.position.set(options.box.x, deskY + BOX.h / 2, options.box.z);
  switcher.rotation.y = options.box.turn || 0;
  group.add(switcher);
  box(switcher, BOX.w, BOX.h, BOX.d, 0, 0, 0, steel);
  // The readout's window.
  box(switcher, 2.0, 1.45, 0.06, -0.42, 0.02, BOX.d / 2 + 0.01, dark);

  var DIGIT = { w: 0.56, h: 1.0, t: 0.12, apart: 0.86 };
  var segmentGeometry = new BoxGeometry(1, 1, 0.02);
  var ledMaterial = new MeshBasicMaterial({ color: 0xffffff });
  var leds = new InstancedMesh(segmentGeometry, ledMaterial, 14);
  owned.push(segmentGeometry, ledMaterial);
  for (var digit = 0; digit < 2; digit++) {
    var cx = -0.42 + (digit - 0.5) * DIGIT.apart;
    var across = [DIGIT.w - DIGIT.t, DIGIT.t];
    var down = [DIGIT.t, DIGIT.h / 2 - DIGIT.t];
    var where = {
      a: [0, DIGIT.h / 2, across],
      g: [0, 0, across],
      d: [0, -DIGIT.h / 2, across],
      f: [-DIGIT.w / 2, DIGIT.h / 4, down],
      b: [DIGIT.w / 2, DIGIT.h / 4, down],
      e: [-DIGIT.w / 2, -DIGIT.h / 4, down],
      c: [DIGIT.w / 2, -DIGIT.h / 4, down],
    };
    for (var s = 0; s < 7; s++) {
      var seg = where[SEGMENT_ORDER[s]];
      at.set(cx + seg[0], 0.02 + seg[1], BOX.d / 2 + 0.05);
      size.set(seg[2][0], seg[2][1], 1);
      leds.setMatrixAt(digit * 7 + s, matrix.compose(at, flat, size));
      leds.setColorAt(digit * 7 + s, LED_OFF);
    }
  }
  switcher.add(leds);

  // The selected guest's power lamp.
  var lampMaterial = new MeshBasicMaterial({ color: POWER.none.clone() });
  owned.push(lampMaterial);
  box(switcher, 0.34, 0.3, 0.05, 1.12, 0.7, BOX.d / 2 + 0.02, lampMaterial);
  // The power switch, under a guard that has to be lifted first: a plate,
  // a toggle that is thrown up while the guest runs and down while it is
  // stopped, and the red cover, hinged along its top edge, that swings up
  // clear of it.
  box(switcher, 0.7, 0.74, 0.04, 1.12, -0.3, BOX.d / 2 + 0.02, plate);
  var lever = new Group();
  lever.position.set(1.12, -0.3, BOX.d / 2 + 0.05);
  switcher.add(lever);
  var collarGeometry = new CylinderGeometry(0.11, 0.11, 0.08, 16);
  var collar = new Mesh(collarGeometry, plate);
  collar.rotation.x = Math.PI / 2;
  collar.position.set(1.12, -0.3, BOX.d / 2 + 0.07);
  switcher.add(collar);
  var batGeometry = new CylinderGeometry(0.075, 0.045, 0.42, 14);
  var leverMesh = new Mesh(batGeometry, chrome);
  leverMesh.rotation.x = Math.PI / 2;
  leverMesh.position.z = 0.24;
  lever.add(leverMesh);
  owned.push(collarGeometry, batGeometry);
  var guardMaterial = new MeshStandardMaterial({ color: 0xc8301c, roughness: 0.45, transparent: true, opacity: 0.86 });
  owned.push(guardMaterial);
  var guard = new Group();
  guard.position.set(1.12, 0.1, BOX.d / 2 + 0.04);
  switcher.add(guard);
  var guardMesh = box(guard, 0.56, 0.78, 0.56, 0, -0.39, 0.28, guardMaterial);
  // Both move as sprung things do: quickly, and a little past where they
  // are going before they settle.
  var guardGoal = 0;
  var guardAngle = 0;
  var guardSpeed = 0;
  var leverGoal = 0;
  var leverAngle = 0;
  var leverSpeed = 0;
  function spring(angle, speed, goal, stiff, damp, dt) {
    var step = Math.min(dt, 0.03);
    speed += ((goal - angle) * stiff - speed * damp) * step;
    return [angle + speed * step, speed];
  }

  var shown = "";
  function setReadout(text) {
    var t = (String(text) + "  ").slice(0, 2);
    if (t === shown) return false;
    shown = t;
    for (var d = 0; d < 2; d++) {
      var lit = SEGMENTS[t[d]] === undefined ? SEGMENTS["-"] : SEGMENTS[t[d]];
      for (var s = 0; s < 7; s++) leds.setColorAt(d * 7 + s, lit.indexOf(SEGMENT_ORDER[s]) >= 0 ? LED_ON : LED_OFF);
    }
    leds.instanceColor.needsUpdate = true;
    return true;
  }
  setReadout("--");

  // --- the keypad ------------------------------------------------------------
  var codes = [];
  KEYPAD.forEach(function (row, r) {
    row.forEach(function (code, c) {
      if (code) codes.push({ code: code, r: r, c: c });
    });
  });
  var pad = new Group();
  pad.position.set(options.keypad.x, deskY, options.keypad.z);
  group.add(pad);
  var padW = 4 * KEY_PITCH + 0.3;
  box(pad, padW, 0.22, padW, 0, 0.11, 0, plate);
  var keyGeometry = new BoxGeometry(KEY_SIZE, 0.2, KEY_SIZE);
  var keyMaterial = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
  var keys = new InstancedMesh(keyGeometry, keyMaterial, codes.length);
  owned.push(keyGeometry, keyMaterial);
  var one = new Vector3(1, 1, 1);
  var glow = new Float32Array(codes.length);
  var tint = new Color();
  function placeKey(i) {
    var k = codes[i];
    // A key that was just pressed is down a little.
    at.set((k.c - 1.5) * KEY_PITCH, 0.32 - 0.07 * glow[i], (k.r - 1.5) * KEY_PITCH);
    keys.setMatrixAt(i, matrix.compose(at, flat, one));
    keys.setColorAt(i, tint.copy(KEY_UP).lerp(KEY_LIT, glow[i]));
  }
  for (var k = 0; k < codes.length; k++) placeKey(k);
  pad.add(keys);
  var legends = legendTexture();
  if (legends) {
    var legendGeometry = new PlaneGeometry(4 * KEY_PITCH, 4 * KEY_PITCH);
    var legendMaterial = new MeshBasicMaterial({ map: legends, transparent: true, depthWrite: false });
    var sheet = new Mesh(legendGeometry, legendMaterial);
    sheet.rotation.x = -Math.PI / 2;
    sheet.position.y = 0.425;
    pad.add(sheet);
    owned.push(legendGeometry, legendMaterial, legends);
  }

  // --- the dial ----------------------------------------------------------------
  var dial = new Group();
  dial.position.set(options.dial.x, deskY, options.dial.z);
  group.add(dial);
  var dialPlate = box(dial, 2.2, 0.16, 2.2, 0, 0.08, 0, plate);
  var knob = new Group();
  knob.position.y = 0.16;
  dial.add(knob);
  var knobGeometry = new CylinderGeometry(0.72, 0.8, 0.42, 36);
  var knobMesh = new Mesh(knobGeometry, steel);
  knobMesh.position.y = 0.21;
  knob.add(knobMesh);
  owned.push(knobGeometry);
  // The pointer: a bar from the middle to the rim.
  box(knob, 0.12, 0.06, 0.6, 0, 0.45, -0.4, cream);
  // The marks its clicks line up with.
  for (var mark = 0; mark < 12; mark++) {
    var a = mark * DIAL_STEP;
    box(dial, 0.07, 0.05, 0.16, Math.sin(a) * 0.98, 0.18, -Math.cos(a) * 0.98, cream).rotation.y = -a;
  }
  var dialGoal = 0;
  var dialAngle = 0;
  var dialAt = 0;

  // --- the lock on target button -------------------------------------------
  // A square lit button under a stencilled plate. It glows while the view
  // is locked on the terminal.
  var lock = new Group();
  lock.position.set(options.lock.x, deskY, options.lock.z);
  lock.rotation.y = options.lock.turn || 0;
  // A button for a finger, not a fist.
  lock.scale.setScalar(0.45);
  group.add(lock);
  box(lock, 2.3, 0.3, 2.6, 0, 0.15, 0, steel);
  var lockMaterial = new MeshBasicMaterial({ color: LOCK_OFF.clone() });
  owned.push(lockMaterial);
  var lockButton = box(lock, 1.3, 0.3, 1.3, 0, 0.42, 0.42, lockMaterial);
  // Yellow and black, as a thing not to be pressed lightly is edged.
  var hazard = new MeshStandardMaterial({ color: 0xd8b21c, roughness: 0.6 });
  owned.push(hazard);
  box(lock, 1.7, 0.04, 1.7, 0, 0.31, 0.42, hazard);
  box(lock, 1.48, 0.05, 1.48, 0, 0.315, 0.42, dark);
  var lockLabel = lockTexture();
  if (lockLabel) {
    var lockLabelGeometry = new PlaneGeometry(2.0, 0.62);
    var lockLabelMaterial = new MeshBasicMaterial({ map: lockLabel });
    var plateMesh = new Mesh(lockLabelGeometry, lockLabelMaterial);
    plateMesh.rotation.x = -Math.PI / 2;
    plateMesh.position.set(0, 0.305, -0.86);
    lock.add(plateMesh);
    owned.push(lockLabelGeometry, lockLabelMaterial, lockLabel);
  }
  var lockOn = false;
  var lockDown = 0;

  var world = new Vector3();

  return {
    group: group,
    // What a ray can hit that means something.
    pickables: [keys, knobMesh, dialPlate, guardMesh, leverMesh, lockButton],
    // The key code a hit on one of the pickables stands for: a keypad key,
    // or next and previous for the right and left halves of the dial.
    codeAt: function (hit) {
      if (hit.object === keys && hit.instanceId !== undefined) return codes[hit.instanceId].code;
      // The cover is lifted and shut by itself; the toggle under it is
      // what switches the guest.
      if (hit.object === guardMesh) return "Guard";
      if (hit.object === leverMesh) return "Power";
      if (hit.object === lockButton) return "Lock";
      if (hit.object === knobMesh) return hit.point.x >= dial.getWorldPosition(world).x ? "NumpadAdd" : "NumpadSubtract";
      return null;
    },
    // Whether a hit is on the dial or the plate it stands on.
    onDial: function (hit) {
      return hit.object === knobMesh || hit.object === dialPlate;
    },
    // Two characters on the readout: digits, "-", "_" or a space.
    setReadout: setReadout,
    // "on", "off", or null with nothing selected.
    // `thrown` is where the toggle stands, if not where the lamp says: it
    // is thrown the moment it is used, and the guest follows.
    setPower: function (power, thrown) {
      lampMaterial.color.copy(POWER[power] || POWER.none);
      var at = thrown || power;
      leverGoal = at === "on" ? -0.6 : at === "off" ? 0.6 : 0;
    },
    // Lights the lock on target button, or puts it out; either way it
    // goes down as a pressed button does.
    setLock: function (on) {
      if (on === lockOn) return;
      lockOn = on;
      lockDown = 1;
      lockMaterial.color.copy(on ? LOCK_ON : LOCK_OFF);
    },
    // Lifts the power switch's guard, or lets it fall shut.
    setGuard: function (open) {
      guardGoal = open ? -1.95 : 0;
    },
    // Turns the dial a click for each monitor between the last one it
    // was told of and `number` of `count`, the short way round.
    setDial: function (number, count) {
      var by = number - dialAt;
      dialAt = number;
      if (count > 1 && Math.abs(by) > count / 2) by -= Math.sign(by) * count;
      dialGoal += by * DIAL_STEP;
    },
    // Shows a key going down, however it was pressed.
    press: function (code) {
      for (var i = 0; i < codes.length; i++) {
        if (codes[i].code === code) glow[i] = 1;
      }
    },
    // Moves things on by dt seconds; `still` skips the easing. True while
    // anything is moving.
    update: function (dt, still) {
      var moving = false;
      var lit = false;
      for (var i = 0; i < codes.length; i++) {
        if (glow[i] <= 0) continue;
        glow[i] = Math.max(0, glow[i] - dt / KEY_FLASH_S);
        placeKey(i);
        lit = true;
      }
      if (lit) {
        keys.instanceMatrix.needsUpdate = true;
        keys.instanceColor.needsUpdate = true;
        moving = true;
      }
      if (lockDown > 0) {
        lockDown = still ? 0 : Math.max(0, lockDown - dt / 0.25);
        lockButton.position.y = 0.42 - 0.1 * lockDown;
        moving = true;
      }
      if (guardAngle !== guardGoal || guardSpeed) {
        var g = spring(guardAngle, guardSpeed, guardGoal, 320, 17, dt);
        guardAngle = g[0];
        guardSpeed = g[1];
        // Shut, it stops against the panel.
        if (guardAngle > 0) {
          guardAngle = 0;
          guardSpeed = -guardSpeed * 0.3;
        }
        if (still || (Math.abs(guardGoal - guardAngle) < 0.003 && Math.abs(guardSpeed) < 0.05)) {
          guardAngle = guardGoal;
          guardSpeed = 0;
        }
        guard.rotation.x = guardAngle;
        moving = true;
      }
      if (leverAngle !== leverGoal || leverSpeed) {
        var l = spring(leverAngle, leverSpeed, leverGoal, 1400, 34, dt);
        leverAngle = l[0];
        leverSpeed = l[1];
        if (still || (Math.abs(leverGoal - leverAngle) < 0.003 && Math.abs(leverSpeed) < 0.05)) {
          leverAngle = leverGoal;
          leverSpeed = 0;
        }
        lever.rotation.x = leverAngle;
        moving = true;
      }
      if (dialAngle !== dialGoal) {
        dialAngle = still || Math.abs(dialGoal - dialAngle) < 0.002 ? dialGoal : dialAngle + (dialGoal - dialAngle) * (1 - Math.exp(-dt / 0.09));
        knob.rotation.y = -dialAngle;
        moving = true;
      }
      return moving;
    },
    dispose: function () {
      owned.forEach(function (o) {
        o.dispose();
      });
      leds.dispose();
      keys.dispose();
    },
  };
}
