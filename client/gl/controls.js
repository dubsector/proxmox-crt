// What the monitors are switched with: the switcher box beside the
// terminal, with its two-digit readout, a lamp for the selected guest's
// power and the guarded switch that starts and stops it; a keypad on the
// desk; and a dial. The keypad and dial can be clicked, and they move when
// the real keyboard does the same thing.
//
// The shapes here are plain, like the rest of the grey-box room. A baked
// office has its own model of every part (tools/blender/vt_office.py); the
// parts of it that move are handed to useBaked() and are moved from here,
// and what is drawn here is then only what lights up: the readout and the
// power lamp. The plain parts stay, unseen, to take the clicks.
import {
  Group,
  Mesh,
  BoxGeometry,
  PlaneGeometry,
  CylinderGeometry,
  CircleGeometry,
  BufferGeometry,
  BufferAttribute,
  InstancedMesh,
  DoubleSide,
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
var KEY_UP = new Color(0.62, 0.6, 0.53);
var KEY_LIT = new Color(1.0, 0.86, 0.5);
var POWER = {
  on: new Color(0.25, 1.0, 0.4),
  off: new Color(1.0, 0.2, 0.08),
  none: new Color(0.05, 0.06, 0.05),
};

// The keypad, as a numeric pad is laid out: each key's column and row (the
// far row is 0), how many cells it covers, what is printed on it and which
// of the two colours of cap it has.
export var KEYPAD = [
  { code: "Numpad7", col: 0, row: 0 },
  { code: "Numpad8", col: 1, row: 0 },
  { code: "Numpad9", col: 2, row: 0 },
  { code: "NumpadSubtract", col: 3, row: 0, legend: "−", tone: "grey" },
  { code: "Numpad4", col: 0, row: 1 },
  { code: "Numpad5", col: 1, row: 1 },
  { code: "Numpad6", col: 2, row: 1 },
  { code: "NumpadAdd", col: 3, row: 1, legend: "+", tone: "grey" },
  { code: "Numpad1", col: 0, row: 2 },
  { code: "Numpad2", col: 1, row: 2 },
  { code: "Numpad3", col: 2, row: 2 },
  { code: "NumpadEnter", col: 3, row: 2, h: 2, legend: "↵", tone: "grey" },
  { code: "Numpad0", col: 0, row: 3, w: 2 },
  { code: "NumpadDecimal", col: 2, row: 3, legend: "." },
].map(function (k) {
  return { code: k.code, col: k.col, row: k.row, w: k.w || 1, h: k.h || 1, legend: k.legend || k.code.slice(-1), tone: k.tone || "cream" };
});
export var KEY_PITCH = 0.58;
export var KEY_SIZE = 0.5;
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
  KEYPAD.forEach(function (k) {
    ctx.fillText(k.legend, (k.col + k.w / 2) * cell, (k.row + k.h / 2) * cell + 2);
  });
  var texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

// The readout's fourteen segments as one shape: each a bar with pointed
// ends, leaning a little as these displays do, with a colour of its own.
function segmentGeometry(digit, origin) {
  var LEAN = 0.12;
  var GAP = 0.018;
  var t = digit.t / 2;
  var positions = [];
  function bar(cx, cy, half, upright) {
    var l = half - GAP;
    var outline = [
      [-l, 0],
      [-l + t, t],
      [l - t, t],
      [l, 0],
      [l - t, -t],
      [-l + t, -t],
    ];
    for (var k = 1; k < 5; k++) {
      [outline[0], outline[k + 1], outline[k]].forEach(function (p) {
        var x = cx + (upright ? p[1] : p[0]);
        var y = cy + (upright ? p[0] : p[1]);
        positions.push(origin.x + x + y * LEAN, origin.y + y, origin.z);
      });
    }
  }
  for (var d = 0; d < 2; d++) {
    var cx = (d - 0.5) * digit.apart;
    var across = digit.w / 2;
    var down = digit.h / 4;
    var where = {
      a: [0, digit.h / 2, across, false],
      b: [digit.w / 2, digit.h / 4, down, true],
      c: [digit.w / 2, -digit.h / 4, down, true],
      d: [0, -digit.h / 2, across, false],
      e: [-digit.w / 2, -digit.h / 4, down, true],
      f: [-digit.w / 2, digit.h / 4, down, true],
      g: [0, 0, across, false],
    };
    for (var s = 0; s < 7; s++) {
      var seg = where[SEGMENT_ORDER[s]];
      bar(cx + seg[0], seg[1], seg[2], seg[3]);
    }
  }
  var geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("color", new BufferAttribute(new Float32Array(positions.length), 3));
  return geometry;
}
// Corners of the triangles each segment is made of.
var SEGMENT_VERTS = 12;

// options: { deskY: height of the desk top, box: { x, z, turn } where the
// switcher box stands, keypad: { x, z }, dial: { x, z } }
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
  // What a baked room draws for itself: everything that neither moves nor lights.
  var shell = [];
  shell.push(box(switcher, BOX.w, BOX.h, BOX.d, 0, 0, 0, steel));
  // The readout's window.
  shell.push(box(switcher, 2.0, 1.45, 0.06, -0.42, 0.02, BOX.d / 2 + 0.01, dark));

  var DIGIT = { w: 0.56, h: 1.0, t: 0.12, apart: 0.86 };
  var segments = segmentGeometry(DIGIT, { x: -0.42, y: 0.02, z: BOX.d / 2 + 0.052 });
  var ledMaterial = new MeshBasicMaterial({ color: 0xffffff, vertexColors: true, side: DoubleSide });
  owned.push(segments, ledMaterial);
  switcher.add(new Mesh(segments, ledMaterial));
  var segmentColors = segments.getAttribute("color");
  function lightSegment(index, color) {
    for (var v = 0; v < SEGMENT_VERTS; v++) segmentColors.setXYZ(index * SEGMENT_VERTS + v, color.r, color.g, color.b);
  }

  // The selected guest's power lamp.
  var lampMaterial = new MeshBasicMaterial({ color: POWER.none.clone() });
  owned.push(lampMaterial);
  var lensGeometry = new CircleGeometry(0.1, 24);
  owned.push(lensGeometry);
  var lens = new Mesh(lensGeometry, lampMaterial);
  lens.position.set(1.12, 0.62, BOX.d / 2 + 0.06);
  switcher.add(lens);
  // The power switch, under a guard that has to be lifted first: a plate,
  // a toggle that is thrown up while the guest runs and down while it is
  // stopped, and the red cover, hinged along its top edge, that swings up
  // clear of it.
  shell.push(box(switcher, 0.7, 0.74, 0.04, 1.12, -0.3, BOX.d / 2 + 0.02, plate));
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
      for (var s = 0; s < 7; s++) lightSegment(d * 7 + s, lit.indexOf(SEGMENT_ORDER[s]) >= 0 ? LED_ON : LED_OFF);
    }
    segmentColors.needsUpdate = true;
    return true;
  }
  setReadout("--");

  // --- the keypad ------------------------------------------------------------
  var codes = KEYPAD;
  var pad = new Group();
  pad.position.set(options.keypad.x, deskY, options.keypad.z);
  group.add(pad);
  var padW = 4 * KEY_PITCH + 0.3;
  shell.push(box(pad, padW, 0.22, padW, 0, 0.11, 0, plate));
  var keyGeometry = new BoxGeometry(KEY_SIZE, 0.2, KEY_SIZE);
  var keyMaterial = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
  var keys = new InstancedMesh(keyGeometry, keyMaterial, codes.length);
  owned.push(keyGeometry, keyMaterial);
  var glow = new Float32Array(codes.length);
  var tint = new Color();
  function placeKey(i) {
    var k = codes[i];
    // A key that was just pressed is down a little. One that covers two
    // cells is as much longer as the gap it bridges.
    at.set((k.col + k.w / 2 - 2) * KEY_PITCH, 0.32 - 0.07 * glow[i], (k.row + k.h / 2 - 2) * KEY_PITCH);
    size.set((k.w * KEY_PITCH - (KEY_PITCH - KEY_SIZE)) / KEY_SIZE, 1, (k.h * KEY_PITCH - (KEY_PITCH - KEY_SIZE)) / KEY_SIZE);
    keys.setMatrixAt(i, matrix.compose(at, flat, size));
    keys.setColorAt(i, tint.copy(KEY_UP).lerp(KEY_LIT, glow[i]));
  }
  for (var k = 0; k < codes.length; k++) placeKey(k);
  pad.add(keys);
  var legends = legendTexture();
  var sheet = null;
  if (legends) {
    var legendGeometry = new PlaneGeometry(4 * KEY_PITCH, 4 * KEY_PITCH);
    var legendMaterial = new MeshBasicMaterial({ map: legends, transparent: true, depthWrite: false });
    sheet = new Mesh(legendGeometry, legendMaterial);
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
  shell.push(dialPlate);
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
    var tick = box(dial, 0.07, 0.05, 0.16, Math.sin(a) * 0.98, 0.18, -Math.cos(a) * 0.98, cream);
    tick.rotation.y = -a;
    shell.push(tick);
  }
  var dialGoal = 0;
  var dialAngle = 0;
  var dialAt = 0;

  // --- a baked office's own parts ---------------------------------------------
  // The moving parts of the model, once there is one: { pad: { code: key },
  // knob, guard, lever }, each a node that is moved as its plain stand-in is.
  var baked = null;
  var bakedKeys = [];
  var turnBy = new Quaternion();
  var X_AXIS = new Vector3(1, 0, 0);
  var Y_AXIS = new Vector3(0, 1, 0);
  function turned(part, axis, angle) {
    if (part) part.node.quaternion.copy(part.rest).multiply(turnBy.setFromAxisAngle(axis, angle));
  }
  function resting(node) {
    return node ? { node: node, rest: node.quaternion.clone() } : null;
  }

  var world = new Vector3();

  return {
    group: group,
    shell: shell,
    // What a ray can hit that means something.
    pickables: [keys, knobMesh, dialPlate, guardMesh, leverMesh],
    // The key code a hit on one of the pickables stands for: a keypad key,
    // or next and previous for the right and left halves of the dial.
    codeAt: function (hit) {
      if (hit.object === keys && hit.instanceId !== undefined) return codes[hit.instanceId].code;
      // The cover is lifted and shut by itself; the toggle under it is
      // what switches the guest.
      if (hit.object === guardMesh) return "Guard";
      if (hit.object === leverMesh) return "Power";
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
    // Hands over a baked office's moving parts (see above), which are
    // drawn from here on in place of the plain ones.
    useBaked: function (parts) {
      baked = { knob: resting(parts.knob), guard: resting(parts.guard), lever: resting(parts.lever) };
      bakedKeys = codes.map(function (k) {
        var node = parts.pad[k.code];
        return node ? { node: node, rest: node.position.y, travel: node.userData.travel || 0 } : null;
      });
      [keys, sheet, knob, guard, lever, collar].forEach(function (o) {
        if (o) o.visible = false;
      });
      turned(baked.knob, Y_AXIS, -dialAngle);
      turned(baked.guard, X_AXIS, guardAngle);
      turned(baked.lever, X_AXIS, leverAngle);
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
        // The model's key goes down at once and comes back up.
        if (bakedKeys[i]) bakedKeys[i].node.position.y = bakedKeys[i].rest - bakedKeys[i].travel * Math.min(1, glow[i] * 2.5);
        lit = true;
      }
      if (lit) {
        keys.instanceMatrix.needsUpdate = true;
        keys.instanceColor.needsUpdate = true;
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
        if (baked) turned(baked.guard, X_AXIS, guardAngle);
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
        if (baked) turned(baked.lever, X_AXIS, leverAngle);
        moving = true;
      }
      if (dialAngle !== dialGoal) {
        dialAngle = still || Math.abs(dialGoal - dialAngle) < 0.002 ? dialGoal : dialAngle + (dialGoal - dialAngle) * (1 - Math.exp(-dt / 0.09));
        knob.rotation.y = -dialAngle;
        if (baked) turned(baked.knob, Y_AXIS, -dialAngle);
        moving = true;
      }
      return moving;
    },
    dispose: function () {
      owned.forEach(function (o) {
        o.dispose();
      });
      keys.dispose();
    },
  };
}
