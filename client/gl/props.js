// What a shift leaves on the desk: a logbook and a pen, a mug, a headset
// and a desk lamp. Plain shapes, like the rest of the grey-box room;
// nothing here does anything.
import { Group, Mesh, BoxGeometry, CylinderGeometry, TorusGeometry, ConeGeometry, MeshStandardMaterial, MeshBasicMaterial, PointLight, Color } from "three";

// options: { deskY: height of the desk top, logbook: { x, z, turn },
// mug: { x, z }, headset: { x, z, turn }, lamp: { x, z, turn } }
export function createProps(options) {
  var group = new Group();
  var owned = [];
  var y = options.deskY;

  var cover = new MeshStandardMaterial({ color: 0x2f4a3a, roughness: 0.8 });
  var paper = new MeshStandardMaterial({ color: 0xe6e0cc, roughness: 0.9 });
  var black = new MeshStandardMaterial({ color: 0x141516, roughness: 0.5 });
  var steel = new MeshStandardMaterial({ color: 0x8a8d90, roughness: 0.35, metalness: 0.7 });
  var china = new MeshStandardMaterial({ color: 0xd8d4c4, roughness: 0.4 });
  var coffee = new MeshStandardMaterial({ color: 0x24140a, roughness: 0.3 });
  var enamel = new MeshStandardMaterial({ color: 0x35584a, roughness: 0.45, metalness: 0.2 });
  var bulb = new MeshBasicMaterial({ color: new Color(1.0, 0.9, 0.66) });
  owned.push(cover, paper, black, steel, china, coffee, enamel, bulb);

  function part(parent, geometry, material, x, py, z) {
    var m = new Mesh(geometry, material);
    m.position.set(x, py, z);
    owned.push(geometry);
    parent.add(m);
    return m;
  }
  function stand(at) {
    var g = new Group();
    g.position.set(at.x, y, at.z);
    g.rotation.y = at.turn || 0;
    group.add(g);
    return g;
  }

  // The logbook, open, with a pen across it.
  var book = stand(options.logbook);
  part(book, new BoxGeometry(3.4, 0.1, 2.3), cover, 0, 0.05, 0);
  part(book, new BoxGeometry(1.58, 0.1, 2.1), paper, -0.82, 0.13, 0);
  part(book, new BoxGeometry(1.58, 0.1, 2.1), paper, 0.82, 0.13, 0);
  // Ruled lines of what was written.
  for (var line = 0; line < 7; line++) {
    part(book, new BoxGeometry(1.2 - (line % 3) * 0.2, 0.004, 0.03), black, -0.82 - (line % 3) * 0.1, 0.183, -0.8 + line * 0.22);
  }
  var pen = part(book, new CylinderGeometry(0.035, 0.035, 1.3, 10), black, 0.7, 0.22, 0.1);
  pen.rotation.z = Math.PI / 2;
  pen.rotation.y = 0.5;

  // The mug.
  var mug = stand(options.mug);
  part(mug, new CylinderGeometry(0.36, 0.32, 0.8, 24), china, 0, 0.4, 0);
  part(mug, new CylinderGeometry(0.31, 0.31, 0.02, 24), coffee, 0, 0.8, 0);
  var handle = part(mug, new TorusGeometry(0.22, 0.05, 8, 20, Math.PI), china, 0.36, 0.42, 0);
  handle.rotation.z = -Math.PI / 2;

  // The headset, lying on its side: two cups, the band between them and
  // the boom of its microphone.
  var headset = stand(options.headset);
  var cup = new CylinderGeometry(0.42, 0.42, 0.26, 20);
  owned.push(cup);
  [-0.75, 0.75].forEach(function (side) {
    var c = new Mesh(cup, black);
    c.position.set(side, 0.42, 0);
    c.rotation.z = Math.PI / 2;
    headset.add(c);
  });
  var band = part(headset, new TorusGeometry(0.8, 0.045, 8, 28, Math.PI), steel, 0, 0.42, 0);
  band.rotation.x = -Math.PI / 2 + 0.25;
  var boom = part(headset, new CylinderGeometry(0.025, 0.025, 0.9, 8), steel, -0.75, 0.3, 0.45);
  boom.rotation.x = Math.PI / 2 - 0.3;
  part(headset, new BoxGeometry(0.12, 0.12, 0.18), black, -0.75, 0.17, 0.9);

  // The desk lamp: a base, an arm in two lengths, and a shade over a bulb.
  var lamp = stand(options.lamp);
  part(lamp, new CylinderGeometry(0.7, 0.75, 0.16, 28), enamel, 0, 0.08, 0);
  var lower = part(lamp, new CylinderGeometry(0.05, 0.05, 2.2, 10), steel, 0, 1.15, -0.35);
  lower.rotation.x = -0.32;
  var upper = part(lamp, new CylinderGeometry(0.05, 0.05, 2.0, 10), steel, 0, 2.55, 0.1);
  upper.rotation.x = 0.95;
  var shade = part(lamp, new ConeGeometry(0.62, 0.7, 24, 1, true), enamel, 0, 2.95, 1.0);
  shade.rotation.x = 0.35;
  part(lamp, new CylinderGeometry(0.16, 0.16, 0.2, 12), bulb, 0, 2.78, 0.94);
  var light = new PointLight(new Color(1.0, 0.86, 0.6), 5, 9, 1.5);
  light.position.set(0, 2.5, 1.0);
  lamp.add(light);

  return {
    group: group,
    dispose: function () {
      owned.forEach(function (o) {
        o.dispose();
      });
      light.dispose();
    },
  };
}
