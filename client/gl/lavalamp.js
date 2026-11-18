// A lava lamp on the desk: somebody's own, among the issue equipment. Its
// wax rises and sinks slowly, and it throws a little of its colour on the
// desk around it.
import { Group, Mesh, CylinderGeometry, SphereGeometry, MeshStandardMaterial, MeshBasicMaterial, PointLight, Color } from "three";

var LAMP = {
  baseH: 1.0,
  glassH: 2.4,
  capH: 0.45,
  glassLow: 0.52,
  glassHigh: 0.24,
  blobs: 6,
};

// options: { x, y: the desk top, z, still: no movement (reduced motion) }
export function createLavaLamp(options) {
  var L = LAMP;
  var group = new Group();
  group.position.set(options.x, options.y, options.z);
  var owned = [];

  var metal = new MeshStandardMaterial({ color: 0xb9b4a6, roughness: 0.35, metalness: 0.8 });
  var liquid = new MeshBasicMaterial({ color: new Color(0.5, 0.1, 0.42), transparent: true, opacity: 0.55, depthWrite: false });
  var wax = new MeshBasicMaterial({ color: new Color(1.0, 0.42, 0.12) });
  owned.push(metal, liquid, wax);

  var solid = [];
  function add(geometry, material, y) {
    var m = new Mesh(geometry, material);
    m.position.y = y;
    owned.push(geometry);
    group.add(m);
    solid.push(m);
    return m;
  }

  // The base narrows to a waist and widens again to hold the glass.
  add(new CylinderGeometry(0.3, 0.62, L.baseH * 0.6, 28), metal, L.baseH * 0.3);
  add(new CylinderGeometry(L.glassLow + 0.04, 0.3, L.baseH * 0.4, 28), metal, L.baseH * 0.8);
  var blobGeometry = new SphereGeometry(1, 20, 14);
  owned.push(blobGeometry);
  var blobs = [];
  for (var b = 0; b < L.blobs; b++) {
    var mesh = new Mesh(blobGeometry, wax);
    group.add(mesh);
    blobs.push({ mesh: mesh, size: 0.14 + 0.05 * (b % 3), period: 19 + b * 5.3, phase: b * 1.9, sway: 0.7 + b * 0.23 });
  }
  // The wax that never leaves the bottom.
  var pool = new Mesh(blobGeometry, wax);
  pool.position.y = L.baseH + 0.1;
  pool.scale.set(L.glassLow - 0.08, 0.16, L.glassLow - 0.08);
  group.add(pool);
  // Drawn after the wax, which shows through it.
  var glass = add(new CylinderGeometry(L.glassHigh, L.glassLow, L.glassH, 28), liquid, L.baseH + L.glassH / 2);
  glass.renderOrder = 1;
  add(new CylinderGeometry(0.12, L.glassHigh + 0.03, L.capH, 28), metal, L.baseH + L.glassH + L.capH / 2);

  var light = new PointLight(new Color(1.0, 0.35, 0.3), 2.2, 9, 1.6);
  light.position.y = L.baseH + L.glassH * 0.45;
  group.add(light);

  // The wax goes by its heat, 0 cold .. 1 hot, which follows the bulb
  // slowly. Hot wax is lighter than the liquid and rises; at the top it
  // cools, and sinks. As the lamp cools the blobs slow, stop climbing and
  // settle one by one into the pool at the bottom, the smallest last; and
  // from cold the pool has to warm through before the first one lifts off.
  function place(t, heat) {
    var settled = 0;
    blobs.forEach(function (blob, b) {
      // Up one side of a slow cycle and down the other, lingering at the ends.
      var f = 0.5 - 0.5 * Math.cos(((t + blob.phase * 7) / blob.period) * Math.PI * 2);
      f = f * f * (3 - 2 * f);
      // How far this blob still floats: each needs its own warmth to.
      var needs = 0.18 + 0.1 * (b % 3) + 0.05 * b;
      var floats = Math.max(0, Math.min(1, (heat - needs) / 0.3));
      floats = floats * floats * (3 - 2 * floats);
      settled += 1 - floats;
      var h = 0.06 + (0.08 + f * 0.74) * floats;
      var room = L.glassLow + (L.glassHigh - L.glassLow) * h - blob.size - 0.03;
      var a = t * 0.11 * blob.sway + blob.phase;
      blob.mesh.position.set(Math.cos(a) * Math.max(0, room) * 0.6 * floats, L.baseH + h * L.glassH, Math.sin(a) * Math.max(0, room) * 0.6 * floats);
      // Wax stretches as it moves and rounds off where it rests; cold, it
      // slumps into the pool.
      var stretch = 1 + 0.45 * Math.sin(f * Math.PI) * floats;
      var w = Math.min(blob.size, Math.max(0.06, room + blob.size));
      var slump = 0.55 + 0.45 * floats;
      blob.mesh.scale.set((w / Math.sqrt(stretch)) / Math.sqrt(slump), blob.size * stretch * slump, (w / Math.sqrt(stretch)) / Math.sqrt(slump));
    });
    // The pool is deeper for the wax that has come back to it.
    pool.scale.y = 0.16 + 0.05 * settled;
    pool.position.y = L.baseH + 0.06 + pool.scale.y * 0.4;
  }
  var time = 40;

  // Switched off, the light goes at once; the wax takes its time.
  var LIT = { liquid: new Color(0.5, 0.1, 0.42), wax: new Color(1.0, 0.42, 0.12) };
  var DARK = { liquid: new Color(0.1, 0.04, 0.1), wax: new Color(0.3, 0.12, 0.05) };
  // A real one takes an hour to get going and as long to stop; this one
  // warms through in about a minute and cools in two.
  var WARM_S = 20;
  var COOL_S = 35;
  var on = true;
  var level = 1;
  var heat = 1;
  place(time, heat);
  function show() {
    liquid.color.copy(DARK.liquid).lerp(LIT.liquid, level);
    wax.color.copy(DARK.wax).lerp(LIT.wax, level);
    light.intensity = 2.2 * level;
  }

  return {
    group: group,
    // Moves the wax on by dt seconds. True while it is moving.
    update: function (dt) {
      var goal = on ? 1 : 0;
      var moving = false;
      if (level !== goal) {
        level = options.still || Math.abs(goal - level) < 0.003 ? goal : level + (goal - level) * (1 - Math.exp(-dt / 0.12));
        show();
        moving = true;
      }
      if (options.still) {
        if (heat !== goal) {
          heat = goal;
          place(time, heat);
        }
        return moving;
      }
      if (heat !== goal) heat = Math.abs(goal - heat) < 0.002 ? goal : heat + (goal - heat) * (1 - Math.exp(-dt / (on ? WARM_S : COOL_S)));
      // Cold through and dark, nothing in it moves.
      if (!heat && !on) return moving;
      // Cooler wax is stiffer and slower.
      time += dt * (0.25 + 0.75 * heat);
      place(time, heat);
      return true;
    },
    // What a click over the lamp lands on, and stops at.
    pickables: solid,
    setOn: function (to) {
      on = !!to;
    },
    on: function () {
      return on;
    },
    dispose: function () {
      owned.forEach(function (o) {
        o.dispose();
      });
      light.dispose();
    },
  };
}
