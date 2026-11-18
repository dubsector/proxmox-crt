// The computer room under the wall: a row of cabinets, each with a panel
// of lamps and a tape drive. They are set dressing with a pulse: a cabinet
// given a node's load blinks and spins as busily as the node is working. Plain shapes for now, like the
// rest of the grey-box room.
//
// All the lamps are one draw call and all the reels another.
import {
  Group,
  Mesh,
  BoxGeometry,
  PlaneGeometry,
  CircleGeometry,
  RingGeometry,
  BufferGeometry,
  BufferAttribute,
  InstancedMesh,
  MeshStandardMaterial,
  MeshBasicMaterial,
  Matrix4,
  Vector3,
  Quaternion,
  Color,
} from "three";

// A cabinet, from its top edge down.
export var MACHINE = {
  width: 6,
  height: 11.2,
  depth: 3,
  lampsTop: 0.75,
  lampRows: 6,
  lampCols: 16,
  lampPitch: 0.32,
  deckTop: 3.3,
  deckHeight: 3.9,
  reelRadius: 1.3,
  reelApart: 1.5,
};

var LAMP_TICK_S = 0.11;
var LAMP_ON = new Color(1.0, 0.56, 0.14);
var LAMP_OFF = new Color(0.1, 0.055, 0.02);

// A tape reel seen face on: the flange, the tape wound on it, the hub, and
// three holes through the flange, which are what show it turning.
function reelGeometry(radius) {
  var parts = [
    [new CircleGeometry(radius, 40), [0.62, 0.64, 0.66], 0],
    [new RingGeometry(radius * 0.4, radius * 0.82, 40), [0.16, 0.1, 0.07], 0.01],
    [new CircleGeometry(radius * 0.3, 24), [0.78, 0.79, 0.8], 0.02],
  ];
  for (var h = 0; h < 3; h++) {
    var hole = new CircleGeometry(radius * 0.13, 16);
    var a = (h / 3) * Math.PI * 2;
    hole.translate(Math.cos(a) * radius * 0.6, Math.sin(a) * radius * 0.6, 0);
    parts.push([hole, [0.05, 0.05, 0.06], 0.03]);
  }
  var positions = [];
  var normals = [];
  var colors = [];
  parts.forEach(function (part) {
    var g = part[0].toNonIndexed();
    var p = g.getAttribute("position");
    for (var i = 0; i < p.count; i++) {
      positions.push(p.getX(i), p.getY(i), p.getZ(i) + part[2]);
      normals.push(0, 0, 1);
      colors.push(part[1][0], part[1][1], part[1][2]);
    }
    g.dispose();
    part[0].dispose();
  });
  var out = new BufferGeometry();
  out.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  out.setAttribute("normal", new BufferAttribute(new Float32Array(normals), 3));
  out.setAttribute("color", new BufferAttribute(new Float32Array(colors), 3));
  return out;
}

// options: { slots: [{ x, top, z }] where each cabinet's top edge and face
// are, still: no movement (reduced motion) }
export function createMachines(options) {
  var slots = options.slots;
  var still = !!options.still;
  var M = MACHINE;
  var group = new Group();
  var owned = [];

  var bodyMat = new MeshStandardMaterial({ color: 0x3c4a5a, roughness: 0.7, metalness: 0.15 });
  var panelMat = new MeshStandardMaterial({ color: 0x14171a, roughness: 0.8 });
  var deckMat = new MeshStandardMaterial({ color: 0xc9c6b6, roughness: 0.65 });
  owned.push(bodyMat, panelMat, deckMat);

  function box(w, h, d, x, y, z, material) {
    var m = new Mesh(new BoxGeometry(w, h, d), material);
    m.position.set(x, y, z);
    owned.push(m.geometry);
    group.add(m);
  }

  var lampsPer = M.lampRows * M.lampCols;
  var lampGeometry = new PlaneGeometry(0.19, 0.19);
  var lampMaterial = new MeshBasicMaterial({ color: 0xffffff });
  var lamps = new InstancedMesh(lampGeometry, lampMaterial, Math.max(1, slots.length * lampsPer));
  var reelGeo = reelGeometry(M.reelRadius);
  var reelMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.2 });
  var reels = new InstancedMesh(reelGeo, reelMaterial, Math.max(1, slots.length * 2));
  owned.push(lampGeometry, lampMaterial, reelGeo, reelMaterial);
  lamps.count = slots.length * lampsPer;
  reels.count = slots.length * 2;
  group.add(lamps);
  group.add(reels);

  var matrix = new Matrix4();
  var one = new Vector3(1, 1, 1);
  var flat = new Quaternion();
  var spin = new Quaternion();
  var axis = new Vector3(0, 0, 1);
  var at = new Vector3();

  // What each cabinet is doing. load: null for a cabinet with no node (it
  // idles), -1 for a node that is down (dark and still), else 0..1.
  var state = slots.map(function (slot, i) {
    box(M.width - 0.2, M.height, M.depth, slot.x, slot.top - M.height / 2, slot.z - M.depth / 2, bodyMat);
    box(M.lampCols * M.lampPitch + 0.5, M.lampRows * M.lampPitch + 0.4, 0.1, slot.x, slot.top - M.lampsTop - (M.lampRows * M.lampPitch) / 2, slot.z + 0.03, panelMat);
    box(M.width - 0.9, M.deckHeight, 0.1, slot.x, slot.top - M.deckTop - M.deckHeight / 2, slot.z + 0.03, deckMat);
    for (var l = 0; l < lampsPer; l++) {
      var col = l % M.lampCols;
      var row = Math.floor(l / M.lampCols);
      at.set(slot.x + (col - (M.lampCols - 1) / 2) * M.lampPitch, slot.top - M.lampsTop - (row + 0.5) * M.lampPitch, slot.z + 0.1);
      lamps.setMatrixAt(i * lampsPer + l, matrix.compose(at, flat, one));
      lamps.setColorAt(i * lampsPer + l, LAMP_OFF);
    }
    return {
      load: null,
      lit: new Uint8Array(lampsPer),
      counter: (i * 977) & 0xffff,
      angle: [i * 1.3, i * 2.1 + 0.7],
      speed: 0,
      goal: 0,
      hold: 0.5 + i * 0.37,
    };
  });

  function placeReels(i) {
    var slot = slots[i];
    var st = state[i];
    for (var r = 0; r < 2; r++) {
      at.set(slot.x + (r ? 1 : -1) * M.reelApart, slot.top - M.deckTop - M.deckHeight / 2, slot.z + 0.1);
      spin.setFromAxisAngle(axis, st.angle[r]);
      reels.setMatrixAt(i * 2 + r, matrix.compose(at, spin, one));
    }
  }

  function setLamps(i) {
    var st = state[i];
    for (var l = 0; l < lampsPer; l++) lamps.setColorAt(i * lampsPer + l, st.lit[l] ? LAMP_ON : LAMP_OFF);
  }

  // One step of the lamps: the top row counts, as an address register
  // does, and the rest flicker, all of it faster the busier the node.
  function tickLamps(i) {
    var st = state[i];
    if (st.load === -1) {
      st.lit.fill(0);
      return;
    }
    var busy = st.load === null ? 0.04 : st.load;
    st.counter = (st.counter + 1 + Math.floor(busy * 40 * Math.random())) & 0xffff;
    for (var c = 0; c < M.lampCols; c++) st.lit[c] = (st.counter >> (M.lampCols - 1 - c)) & 1;
    var flip = 0.03 + busy * 0.5;
    for (var l = M.lampCols; l < lampsPer; l++) {
      if (Math.random() < flip) st.lit[l] ^= 1;
    }
  }

  // A tape drive moves in bursts: it winds, stops to read, winds back.
  function stepReels(i, dt) {
    var st = state[i];
    st.hold -= dt;
    if (st.hold <= 0) {
      var busy = st.load === null || st.load === -1 ? 0 : st.load;
      var runs = st.load !== null && st.load !== -1 && Math.random() < 0.35 + busy * 0.6;
      st.goal = runs ? (Math.random() < 0.7 ? 1 : -1) * (2.5 + Math.random() * 6) : 0;
      st.hold = runs ? 0.6 + Math.random() * 3.5 : 0.4 + Math.random() * (2.5 - busy * 2);
    }
    var before = st.speed;
    st.speed += (st.goal - st.speed) * (1 - Math.exp(-dt / 0.18));
    if (Math.abs(st.speed) < 0.01 && st.goal === 0) st.speed = 0;
    if (st.speed === 0 && before === 0) return false;
    // The fuller reel turns slower.
    st.angle[0] -= st.speed * dt;
    st.angle[1] -= st.speed * dt * 0.72;
    placeReels(i);
    return true;
  }

  for (var i = 0; i < slots.length; i++) {
    for (var warm = 0; warm < 8; warm++) tickLamps(i);
    setLamps(i);
    placeReels(i);
  }
  lamps.instanceMatrix.needsUpdate = true;
  if (lamps.instanceColor) lamps.instanceColor.needsUpdate = true;
  reels.instanceMatrix.needsUpdate = true;

  var sinceTick = 0;

  return {
    group: group,
    count: slots.length,
    // How hard cabinet i's node is working: 0..1, -1 when the node is
    // down, null when the cabinet has no node.
    setLoad: function (i, load) {
      if (!state[i]) return;
      var was = state[i].load;
      state[i].load = load;
      if (still && was !== load) {
        tickLamps(i);
        setLamps(i);
        lamps.instanceColor.needsUpdate = true;
      }
    },
    // Moves everything on by dt seconds. True while anything is moving,
    // which is always unless the room is to keep still.
    update: function (dt) {
      if (still || !slots.length) return false;
      sinceTick += dt;
      if (sinceTick >= LAMP_TICK_S) {
        sinceTick = 0;
        for (var i = 0; i < slots.length; i++) {
          tickLamps(i);
          setLamps(i);
        }
        lamps.instanceColor.needsUpdate = true;
      }
      var turned = false;
      for (var r = 0; r < slots.length; r++) {
        if (stepReels(r, dt)) turned = true;
      }
      if (turned) reels.instanceMatrix.needsUpdate = true;
      return true;
    },
    dispose: function () {
      owned.forEach(function (o) {
        o.dispose();
      });
      lamps.dispose();
      reels.dispose();
    },
  };
}
