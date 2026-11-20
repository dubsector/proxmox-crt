// The racks either side of the wall of monitors, as a firing room has
// them: a clock, a board of status lamps, a row of meters, a scope and a
// smaller board of lamps in each. All of it shows the cluster (see
// telemetry.js for what each rack is given): until a rack is told what to
// show, its lamps are dark, its needles at rest and its clock all dashes.
// Plain shapes, like the rest of the grey-box room.
//
// All the lamps are one draw call, and all the clocks' segments another.
import {
  Group,
  Mesh,
  Line,
  BoxGeometry,
  PlaneGeometry,
  CircleGeometry,
  BufferGeometry,
  BufferAttribute,
  InstancedMesh,
  MeshStandardMaterial,
  MeshBasicMaterial,
  LineBasicMaterial,
  CanvasTexture,
  SRGBColorSpace,
  Matrix4,
  Vector3,
  Quaternion,
  Color,
} from "three";
import { SEGMENTS, SEGMENT_ORDER } from "./controls.js";

// A rack, from its top edge down.
export var PANEL = {
  width: 6,
  height: 26,
  depth: 3,
  clockTop: 0.6,
  clockHeight: 2.6,
  boardTop: 3.9,
  boardCols: 5,
  boardRows: 9,
  boardPitchX: 1.02,
  boardPitchY: 0.7,
  metersTop: 11.0,
  meters: 3,
  meterRadius: 0.78,
  scopeTop: 14.4,
  scopeWidth: 4.6,
  scopeHeight: 3.6,
  lowerTop: 19.0,
  lowerRows: 5,
};

var CLOCK_ON = new Color(1.0, 0.62, 0.1);
var CLOCK_OFF = new Color(0.05, 0.03, 0.008);
// What a status lamp can show: nothing, green, amber, red (telemetry.js's
// DARK, GREEN, AMBER and RED).
var LAMPS = [new Color(0.035, 0.045, 0.04), new Color(0.2, 0.9, 0.35), new Color(1.0, 0.62, 0.1), new Color(1.0, 0.16, 0.08)];
var SCOPE_POINTS = 96;
// A scope's beam: how long it takes to cross the screen, how far behind it
// (in points) the trace has faded most of the way, and how bright the
// trace stays once it has.
var SWEEP_S = 4;
var TRACE_FADE = 14;
var TRACE_DIM = 0.2;
// The dark gap just ahead of the beam, in points, where the old trace has
// been wiped and the new one is yet to be drawn.
var TRACE_GAP = 5;
var TRACE = new Color(0x66ff9a);
// How far a meter's needle swings either side of straight up.
var METER_SWING = 1.05;

// A clock's label, which can be written again: what a clock counts
// depends on the cluster.
function labelTexture() {
  if (typeof document === "undefined") return null;
  var canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 48;
  if (!canvas.getContext("2d")) return null;
  var texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function writeLabel(texture, text) {
  var ctx = texture.image.getContext("2d");
  ctx.clearRect(0, 0, 512, 48);
  ctx.fillStyle = "#d9d3bd";
  ctx.font = "bold 30px ui-monospace, Menlo, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Letters apart, as engraved labels have them, and no wider than the plate.
  ctx.fillText(text.split("").join(text.length > 12 ? "\u200a" : " "), 256, 26, 500);
  texture.needsUpdate = true;
}

// The six digits of a count of seconds: hours, minutes and seconds
// ("hms", or "day" for a time of day), or days, hours and minutes ("dhm").
// A count stops at 99 of its largest.
export function clockDigits(seconds, form) {
  var s = Math.max(0, Math.floor(seconds));
  // A time of day goes round at midnight.
  if (form === "day") s %= 86400;
  var parts = form === "dhm" ? [Math.floor(s / 86400), Math.floor(s / 3600) % 24, Math.floor(s / 60) % 60] : [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60];
  if (parts[0] > 99) parts = form === "dhm" ? [99, 23, 59] : [99, 59, 59];
  return two(parts[0]) + two(parts[1]) + two(parts[2]);
}

function two(n) {
  return (n < 10 ? "0" : "") + n;
}

// options: { racks: [{ x, top, z }] where each rack's top edge and face
// are, still: no movement (reduced motion) }
export function createPanels(options) {
  var racks = options.racks;
  var still = !!options.still;
  var P = PANEL;
  var group = new Group();
  var owned = [];

  var bodyMat = new MeshStandardMaterial({ color: 0x3c4a5a, roughness: 0.7, metalness: 0.15 });
  var panelMat = new MeshStandardMaterial({ color: 0x14171a, roughness: 0.8 });
  var faceMat = new MeshStandardMaterial({ color: 0xd9d3bd, roughness: 0.65 });
  var needleMat = new MeshBasicMaterial({ color: 0x1a0d08 });
  var redMat = new MeshBasicMaterial({ color: 0xc8301c });
  var screenMat = new MeshBasicMaterial({ color: 0x06100a });
  var traceMat = new LineBasicMaterial({ vertexColors: true });
  var spotMat = new MeshBasicMaterial({ color: 0xd8ffe4 });
  var spotGeometry = new CircleGeometry(0.055, 12);
  owned.push(spotMat);
  owned.push(bodyMat, panelMat, faceMat, needleMat, redMat, screenMat, traceMat);

  function add(parent, geometry, material, x, y, z) {
    var m = new Mesh(geometry, material);
    m.position.set(x, y, z);
    owned.push(geometry);
    parent.add(m);
    return m;
  }
  // The racks' bodies and panels: what a baked room draws for itself.
  var shell = [];
  function box(w, h, d, x, y, z, material) {
    var m = add(group, new BoxGeometry(w, h, d), material, x, y, z);
    shell.push(m);
    return m;
  }

  var matrix = new Matrix4();
  var at = new Vector3();
  var size = new Vector3();
  var flat = new Quaternion();
  var one = new Vector3(1, 1, 1);

  var lampsPer = P.boardCols * (P.boardRows + P.lowerRows);
  var lampGeometry = new PlaneGeometry(P.boardPitchX - 0.15, P.boardPitchY - 0.14);
  var lampMaterial = new MeshBasicMaterial({ color: 0xffffff });
  var lamps = new InstancedMesh(lampGeometry, lampMaterial, Math.max(1, racks.length * lampsPer));
  lamps.count = racks.length * lampsPer;
  var segmentGeometry = new BoxGeometry(1, 1, 0.02);
  var segmentMaterial = new MeshBasicMaterial({ color: 0xffffff });
  // Six digits and the four dots of two colons.
  var SEGS_PER = 6 * 7 + 4;
  var segments = new InstancedMesh(segmentGeometry, segmentMaterial, Math.max(1, racks.length * SEGS_PER));
  segments.count = racks.length * SEGS_PER;
  owned.push(lampGeometry, lampMaterial, segmentGeometry, segmentMaterial);
  group.add(lamps);
  group.add(segments);

  var DIGIT = { w: 0.44, h: 1.1, t: 0.11, pitch: 0.7, pair: 0.3 };

  var state = racks.map(function (rack, i) {
    var face = rack.z + 0.04;
    box(P.width - 0.2, P.height, P.depth, rack.x, rack.top - P.height / 2, rack.z - P.depth / 2, bodyMat);

    // The clock: hours, minutes and seconds.
    var clockY = rack.top - P.clockTop - P.clockHeight / 2;
    box(P.width - 0.9, P.clockHeight, 0.1, rack.x, clockY, rack.z + 0.03, panelMat);
    var label = labelTexture();
    if (label) {
      var labelMat = new MeshBasicMaterial({ map: label, transparent: true });
      add(group, new PlaneGeometry(4.4, 0.41), labelMat, rack.x, clockY + 0.95, face + 0.06);
      owned.push(labelMat, label);
    }
    var digitY = clockY - 0.25;
    var total = 6 * DIGIT.pitch + 2 * DIGIT.pair;
    for (var d = 0; d < 6; d++) {
      var cx = rack.x - total / 2 + DIGIT.pitch / 2 + d * DIGIT.pitch + Math.floor(d / 2) * DIGIT.pair;
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
        at.set(cx + seg[0], digitY + seg[1], face + 0.07);
        size.set(seg[2][0], seg[2][1], 1);
        segments.setMatrixAt(i * SEGS_PER + d * 7 + s, matrix.compose(at, flat, size));
        segments.setColorAt(i * SEGS_PER + d * 7 + s, CLOCK_OFF);
      }
    }
    for (var dot = 0; dot < 4; dot++) {
      var pair = Math.floor(dot / 2);
      at.set(rack.x - total / 2 + (pair + 1) * 2 * DIGIT.pitch + pair * DIGIT.pair + DIGIT.pair / 2, digitY + (dot % 2 ? 0.25 : -0.25), face + 0.07);
      size.set(0.13, 0.13, 1);
      segments.setMatrixAt(i * SEGS_PER + 42 + dot, matrix.compose(at, flat, size));
      segments.setColorAt(i * SEGS_PER + 42 + dot, CLOCK_ON);
    }

    // The board of status lamps.
    var boardH = P.boardRows * P.boardPitchY;
    box(P.boardCols * P.boardPitchX + 0.4, boardH + 0.4, 0.1, rack.x, rack.top - P.boardTop - boardH / 2, rack.z + 0.03, panelMat);
    var lowerH = P.lowerRows * P.boardPitchY;
    box(P.boardCols * P.boardPitchX + 0.4, lowerH + 0.4, 0.1, rack.x, rack.top - P.lowerTop - lowerH / 2, rack.z + 0.03, panelMat);
    for (var l = 0; l < lampsPer; l++) {
      var col = l % P.boardCols;
      var row = Math.floor(l / P.boardCols);
      // The rows past the board's own are the smaller board under the scope.
      var lampY = row < P.boardRows ? P.boardTop + (row + 0.5) * P.boardPitchY : P.lowerTop + (row - P.boardRows + 0.5) * P.boardPitchY;
      at.set(rack.x + (col - (P.boardCols - 1) / 2) * P.boardPitchX, rack.top - lampY, face + 0.07);
      lamps.setMatrixAt(i * lampsPer + l, matrix.compose(at, flat, one));
      lamps.setColorAt(i * lampsPer + l, LAMPS[0]);
    }

    // The meters: a face, a red band at the top of its scale, a needle.
    var needles = [];
    var meterY = rack.top - P.metersTop - P.meterRadius;
    box(P.width - 0.9, P.meterRadius * 2 + 0.6, 0.1, rack.x, meterY, rack.z + 0.03, panelMat);
    for (var m = 0; m < P.meters; m++) {
      var mx = rack.x + (m - (P.meters - 1) / 2) * (P.meterRadius * 2 + 0.1);
      add(group, new CircleGeometry(P.meterRadius, 32), faceMat, mx, meterY, face + 0.06);
      var band = add(group, new BoxGeometry(0.12, 0.3, 0.02), redMat, mx, meterY - 0.25, face + 0.08);
      band.position.x += Math.sin(METER_SWING * 0.85) * 0.6;
      band.position.y += Math.cos(METER_SWING * 0.85) * 0.6;
      band.rotation.z = -METER_SWING * 0.85;
      // The needle turns about the bottom of the face.
      var pivot = new Group();
      pivot.position.set(mx, meterY - 0.25, face + 0.09);
      group.add(pivot);
      add(pivot, new BoxGeometry(0.05, 0.8, 0.02), needleMat, 0, 0.4, 0);
      pivot.rotation.z = METER_SWING;
      needles.push({ pivot: pivot, value: 0, given: null, phase: m * 0.7 });
    }

    // The scope.
    var scopeY = rack.top - P.scopeTop - P.scopeHeight / 2;
    box(P.scopeWidth + 0.5, P.scopeHeight + 0.5, 0.1, rack.x, scopeY, rack.z + 0.03, panelMat);
    add(group, new PlaneGeometry(P.scopeWidth, P.scopeHeight), screenMat, rack.x, scopeY, face + 0.06);
    var traceGeometry = new BufferGeometry();
    var points = new Float32Array(SCOPE_POINTS * 3);
    for (var p = 0; p < SCOPE_POINTS; p++) {
      points[p * 3] = rack.x + (p / (SCOPE_POINTS - 1) - 0.5) * (P.scopeWidth - 0.3);
      points[p * 3 + 1] = scopeY;
      points[p * 3 + 2] = face + 0.08;
    }
    traceGeometry.setAttribute("position", new BufferAttribute(points, 3));
    traceGeometry.setAttribute("color", new BufferAttribute(new Float32Array(SCOPE_POINTS * 3), 3));
    // The beam's spot, which a room that keeps still does not show.
    var spot = add(group, spotGeometry, spotMat, rack.x, scopeY, face + 0.09);
    spot.visible = false;
    group.add(new Line(traceGeometry, traceMat));
    owned.push(traceGeometry);

    return { needles: needles, trace: traceGeometry, scopeY: scopeY, shown: "", label: label, labelText: null, clock: null, clockAt: 0, scope: null, lampCodes: null, drawn: new Float32Array(SCOPE_POINTS), spot: spot, beam: (i * 37) % SCOPE_POINTS };
  });

  // A clock keeps the time of day, or counts on from what it was last
  // told; one told nothing shows dashes.
  function clockText(st) {
    var clock = st.clock;
    if (!clock) return "------";
    var now = new Date();
    if (clock.kind === "local") return two(now.getHours()) + two(now.getMinutes()) + two(now.getSeconds());
    if (clock.kind === "gmt") return two(now.getUTCHours()) + two(now.getUTCMinutes()) + two(now.getUTCSeconds());
    if (typeof clock.seconds !== "number") return "------";
    return clockDigits(clock.seconds + (clock.ticking ? (Date.now() - st.clockAt) / 1000 : 0), clock.form);
  }
  function setClocks() {
    var changed = false;
    racks.forEach(function (rack, i) {
      var text = clockText(state[i]);
      if (text === state[i].shown) return;
      state[i].shown = text;
      for (var d = 0; d < 6; d++) {
        var lit = SEGMENTS[text[d]];
        for (var s = 0; s < 7; s++) segments.setColorAt(i * SEGS_PER + d * 7 + s, lit.indexOf(SEGMENT_ORDER[s]) >= 0 ? CLOCK_ON : CLOCK_OFF);
      }
      changed = true;
    });
    if (changed) segments.instanceColor.needsUpdate = true;
  }

  function setNeedle(n) {
    n.pivot.rotation.z = METER_SWING - Math.max(0, Math.min(1, n.value)) * 2 * METER_SWING;
  }

  // What the scope was given, at point p: the readings are spread across
  // as many points as the scope has. With none it is nothing.
  function given(st, p) {
    var readings = st.scope;
    if (!readings || !readings.length) return 0;
    var at = (p / (SCOPE_POINTS - 1)) * (readings.length - 1);
    var lo = Math.floor(at);
    var hi = Math.min(readings.length - 1, lo + 1);
    return Math.max(0, Math.min(1, readings[lo] + (readings[hi] - readings[lo]) * (at - lo)));
  }
  function placePoint(st, p) {
    st.trace.getAttribute("position").setY(p, st.scopeY + (st.drawn[p] * 1.8 - 0.9) * (P.scopeHeight / 2 - 0.35));
  }
  // The whole trace at once, as a room that keeps still shows it.
  function drawTrace(st) {
    var color = st.trace.getAttribute("color");
    for (var p = 0; p < SCOPE_POINTS; p++) {
      st.drawn[p] = given(st, p);
      placePoint(st, p);
      color.setXYZ(p, TRACE.r, TRACE.g, TRACE.b);
    }
    st.trace.getAttribute("position").needsUpdate = true;
    color.needsUpdate = true;
  }
  // The beam crosses the screen from left to right, over and over, and
  // draws the trace as it goes: each point shows what the scope was last
  // given when the beam last passed it, brightest where it has just been
  // and fading behind, as a slow phosphor does.
  function sweep(st, dt) {
    var before = st.beam;
    st.beam = (st.beam + (dt / SWEEP_S) * SCOPE_POINTS) % SCOPE_POINTS;
    var passed = Math.floor(st.beam) - Math.floor(before);
    if (passed < 0) passed += SCOPE_POINTS;
    for (var k = 0; k < passed; k++) {
      var p = (Math.floor(before) + 1 + k) % SCOPE_POINTS;
      st.drawn[p] = given(st, p);
      placePoint(st, p);
    }
    if (passed) st.trace.getAttribute("position").needsUpdate = true;
    var color = st.trace.getAttribute("color");
    for (var q = 0; q < SCOPE_POINTS; q++) {
      var behind = st.beam - q;
      if (behind < 0) behind += SCOPE_POINTS;
      var glow = behind > SCOPE_POINTS - TRACE_GAP ? 0 : TRACE_DIM + (1 - TRACE_DIM) * Math.exp(-behind / TRACE_FADE);
      color.setXYZ(q, TRACE.r * glow, TRACE.g * glow, TRACE.b * glow);
    }
    color.needsUpdate = true;
    // The spot itself, on the point it has just drawn.
    var position = st.trace.getAttribute("position");
    var head = Math.floor(st.beam);
    st.spot.position.set(position.getX(head), position.getY(head), position.getZ(head) + 0.01);
    st.spot.visible = true;
  }

  setClocks();
  state.forEach(function (st) {
    drawTrace(st);
  });
  lamps.instanceMatrix.needsUpdate = true;
  segments.instanceMatrix.needsUpdate = true;

  var time = 0;

  return {
    group: group,
    shell: shell,
    // How many lamps each rack's boards have between them, and how many
    // to a row.
    lampsPer: lampsPer,
    lampCols: P.boardCols,
    scopePoints: SCOPE_POINTS,
    // What rack `i` shows: { label: over its clock, clock: { kind: "gmt" or
    // "local" } or { seconds, ticking, form: "hms", "dhm" or "day" } (seconds
    // null: not known), lamps: a code for each (0 dark, 1 green, 2 amber,
    // 3 red), meters: [0..1, or null for not known], scope: readings 0..1,
    // oldest first }.
    set: function (i, reading) {
      var st = state[i];
      if (!st) return;
      if (st.label && reading.label !== st.labelText) {
        st.labelText = reading.label;
        writeLabel(st.label, reading.label || "");
      }
      st.clock = reading.clock || null;
      st.clockAt = Date.now();
      var codes = reading.lamps || [];
      var changed = false;
      if (!st.lampCodes) st.lampCodes = new Uint8Array(lampsPer);
      for (var l = 0; l < lampsPer; l++) {
        var code = codes[l] || 0;
        if (code === st.lampCodes[l]) continue;
        st.lampCodes[l] = code;
        lamps.setColorAt(i * lampsPer + l, LAMPS[code] || LAMPS[0]);
        changed = true;
      }
      if (changed) lamps.instanceColor.needsUpdate = true;
      st.needles.forEach(function (n, m) {
        var value = reading.meters ? reading.meters[m] : null;
        n.given = typeof value === "number" ? Math.max(0, Math.min(1, value)) : null;
        if (still) {
          n.value = n.given || 0;
          setNeedle(n);
        }
      });
      st.scope = reading.scope || null;
      if (still) drawTrace(st);
      setClocks();
    },
    // Moves everything on by dt seconds. True while anything is moving,
    // which is always unless the room is to keep still.
    update: function (dt) {
      setClocks();
      if (still || !racks.length) return false;
      time += dt;
      state.forEach(function (st) {
        st.needles.forEach(function (n) {
          // A needle that reads something is never quite still; one that
          // reads nothing lies at rest.
          var goal = n.given === null ? 0 : n.given + Math.sin(time * 7 + n.phase) * 0.008;
          n.value += (goal - n.value) * (1 - Math.exp(-dt / 0.35));
          setNeedle(n);
        });
        sweep(st, dt);
      });
      return true;
    },
    dispose: function () {
      owned.forEach(function (o) {
        o.dispose();
      });
      lamps.dispose();
      segments.dispose();
    },
  };
}
