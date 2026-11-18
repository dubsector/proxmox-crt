// What a shift leaves on the desk: a logbook and a pen, a mug, a headset
// and a desk lamp. Plain shapes, like the rest of the grey-box room, but
// for the lamp, which is the one from terminal; nothing here does anything.
import { Group, Mesh, BoxGeometry, CylinderGeometry, TorusGeometry, BufferGeometry, BufferAttribute, MeshStandardMaterial, MeshBasicMaterial, PointLight, Color, DoubleSide } from "three";
import { LAMP_PARTS } from "./lamp-model.js";

// The lamp is modelled in metres; the room is in tube units of about 61 mm.
var PER_METRE = 1 / 0.061;

function bytes(base64) {
  var text = atob(base64);
  var out = new Uint8Array(text.length);
  for (var i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}
function floats(base64) {
  return new Float32Array(bytes(base64).buffer);
}
function shorts(base64) {
  return new Uint16Array(bytes(base64).buffer);
}

// options: { deskY: height of the desk top, logbook: { x, z, turn },
// mug: { x, z }, headset: { x, z, turn }, lamp: { x, z, turn } }
export function createProps(options) {
  var group = new Group();
  var owned = [];
  var y = options.deskY;

  var cover = new MeshStandardMaterial({ color: 0x2f4a3a, roughness: 0.8 });
  var paper = new MeshStandardMaterial({ color: 0xe6e0cc, roughness: 0.9 });
  var black = new MeshStandardMaterial({ color: 0x141516, roughness: 0.5 });
  var steel = new MeshStandardMaterial({ color: 0x9a9995, roughness: 0.3, metalness: 0.7 });
  var china = new MeshStandardMaterial({ color: 0xd8d4c4, roughness: 0.4 });
  var coffee = new MeshStandardMaterial({ color: 0x24140a, roughness: 0.3 });
  var enamel = new MeshStandardMaterial({ color: 0x1b1c1b, roughness: 0.32, metalness: 0.2, side: DoubleSide });
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

  // The desk lamp: terminal's own, with its sprung arm, in black enamel.
  // Its head reaches out along the lamp's +X.
  var lamp = stand(options.lamp);
  lamp.scale.setScalar(PER_METRE);
  var lampMeshes = [];
  function lampPart(name, material) {
    var geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(floats(LAMP_PARTS[name].position), 3));
    geometry.setAttribute("normal", new BufferAttribute(floats(LAMP_PARTS[name].normal), 3));
    geometry.setIndex(new BufferAttribute(shorts(LAMP_PARTS[name].index), 1));
    owned.push(geometry);
    var m = new Mesh(geometry, material);
    lamp.add(m);
    lampMeshes.push(m);
  }
  lampPart("base", enamel);
  lampPart("arm", steel);
  lampPart("shade", enamel);
  lampPart("shadeglow", bulb);
  var light = new PointLight(new Color(1.0, 0.78, 0.5), 6, 11, 1.5);
  light.position.set(0.215, 0.17, -0.017);
  lamp.add(light);

  // The lamp's switch: its light comes up quickly and dies away a little
  // slower, as a small filament does.
  var BULB_LIT = new Color(1.0, 0.9, 0.66);
  var BULB_DARK = new Color(0.16, 0.15, 0.13);
  var lampOn = true;
  var lampLevel = 1;

  return {
    group: group,
    // What a click over the lamp lands on, and stops at.
    lampPickables: lampMeshes,
    setLamp: function (on) {
      lampOn = !!on;
    },
    lampOn: function () {
      return lampOn;
    },
    // True while the lamp's light is changing.
    update: function (dt, still) {
      var goal = lampOn ? 1 : 0;
      if (lampLevel === goal) return false;
      lampLevel = still || Math.abs(goal - lampLevel) < 0.003 ? goal : lampLevel + (goal - lampLevel) * (1 - Math.exp(-dt / (lampOn ? 0.035 : 0.09)));
      bulb.color.copy(BULB_DARK).lerp(BULB_LIT, lampLevel);
      light.intensity = 6 * lampLevel;
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
