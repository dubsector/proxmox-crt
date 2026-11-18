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

  function add(geometry, material, y) {
    var m = new Mesh(geometry, material);
    m.position.y = y;
    owned.push(geometry);
    group.add(m);
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

  function place(t) {
    blobs.forEach(function (blob) {
      // Up one side of a slow cycle and down the other, lingering at the ends.
      var f = 0.5 - 0.5 * Math.cos(((t + blob.phase * 7) / blob.period) * Math.PI * 2);
      f = f * f * (3 - 2 * f);
      var h = 0.14 + f * 0.74;
      var room = L.glassLow + (L.glassHigh - L.glassLow) * h - blob.size - 0.03;
      var a = t * 0.11 * blob.sway + blob.phase;
      blob.mesh.position.set(Math.cos(a) * Math.max(0, room) * 0.6, L.baseH + h * L.glassH, Math.sin(a) * Math.max(0, room) * 0.6);
      // Wax stretches as it moves and rounds off where it rests.
      var stretch = 1 + 0.45 * Math.sin(f * Math.PI);
      var w = Math.min(blob.size, Math.max(0.06, room + blob.size));
      blob.mesh.scale.set(w / Math.sqrt(stretch), blob.size * stretch, w / Math.sqrt(stretch));
    });
  }
  var time = 40;
  place(time);

  return {
    group: group,
    // Moves the wax on by dt seconds. True while it is moving.
    update: function (dt) {
      if (options.still) return false;
      time += dt;
      place(time);
      return true;
    },
    dispose: function () {
      owned.forEach(function (o) {
        o.dispose();
      });
      light.dispose();
    },
  };
}
