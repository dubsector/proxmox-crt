// The room, in grey-box form: a rack wall of small monitors, a desk with the
// terminal on it and a strip of node monitors above its keyboard, a computer room of lamps and
// tape drives under the wall, and a seat to look at them from. Plain boxes under plain lights for now; the modelled, baked office replaces the
// geometry here and nothing else.
//
// This file owns what is drawn and where. It knows nothing about Proxmox:
// it is handed text grids to put on screens and reports which monitor was
// clicked.
import {
  WebGLRenderer,
  Scene,
  PerspectiveCamera,
  Mesh,
  BoxGeometry,
  PlaneGeometry,
  MeshStandardMaterial,
  AmbientLight,
  DirectionalLight,
  PointLight,
  Raycaster,
  Vector2,
  Vector3,
  Matrix4,
  Quaternion,
  Euler,
  Color,
} from "three";
import { RASTER, faceToRaster } from "./gl/raster.js";
import { paintGrid } from "./gl/textgrid.js";
import { createTube, DECAY_SLOW_S } from "./gl/tube.js";
import { createBank, createCabinetGeometry, CABINET } from "./gl/bank.js";
import { PHOSPHORS, GLASS_T, EMISSION_GAIN, faceHit } from "./gl/face.js";
import { createMachines, MACHINE } from "./gl/machines.js";
import { createControls } from "./gl/controls.js";
import { createKeyboard } from "./gl/keyboard.js";
import { createPanels, PANEL } from "./gl/panels.js";
import { createLavaLamp } from "./gl/lavalamp.js";
import { createBoards } from "./gl/boards.js";
import { createProps } from "./gl/props.js";
import { createCordSwitch } from "./gl/cordswitch.js";

// Everything is in tube units (about 61 mm): the desk terminal's tube face
// is 4 x 3 of them and sits at the origin, facing +Z.
//
// Wall monitors are 9-inch sets, three quarters the size of the terminal's
// 12-inch tube, in a rack with a little steel showing between them.
var WALL_SCALE = 0.75;
var PITCH_X = 3.9;
var PITCH_Y = 3.3;
var WALL_Z = -36;
// Centre of the bottom row: as low as it can be with the whole row still
// showing over the top of the terminal from the seat.
var WALL_BOTTOM_Y = 2.4;
var DESK_Y = CABINET.bottom - 0.05;
// The node monitors' strip above the keyboard: how big its sets are, how
// far in front of the terminal they sit, and how far they lie back.
var SIDE_SCALE = 0.34;
var SIDE_GAP = 0.14;
var SIDE_Z = 2.9;
var SIDE_LEAN = 1.0;
// The cabinets under the wall: how many stand either side of the middle,
// and how far from it the first begins. They run right across, behind the
// terminal too, so the wall is not bare wherever the terminal is seen from.
var MACHINES_A_SIDE = 4;
var MACHINES_FROM = 0;
// Beyond the monitors and the rack beside them, each way: a big board with
// this many more cabinets under it, a last rack in the corner, and then the
// side wall, with this many racks along it.
var BOARD_MACHINES = 4;
var SIDE_RACKS = 2;
// Each wall picture is half the desk terminal's raster each way, and holds
// 13 x 4 characters of the 9 x 14 ROM at three times its size: big enough
// to read from the seat.
var WALL_W = RASTER.width / 2;
var WALL_H = RASTER.height / 2;
var WALL_TEXT_SCALE = 3;

// Where the viewer's eye is, and the views it can be sent to by name.
// Seated, the whole wall and the terminal's screen under it are in view at
// once, so nothing has to move to read one and pick from the other. Looking
// down brings the keyboard up into the frame, and turning to a side brings
// the switches on that side of the desk.
var EYE = new Vector3(0, 2.8, 9);
var VIEW = {
  seat: { pitch: -6, fov: 45 },
  keys: { pitch: -29, fov: 44 },
};
// The view is the viewer's to move: dragging turns the head, this far
// either way and this far up and down (degrees), and it stays where it is
// left.
var LOOK_YAW_MAX = 85;
// How far the head turns to follow the pointer to the edge of the window
// (degrees), and what share of that a pointer near the middle gets: little,
// so that pointing at a monitor does not send it away.
var FOLLOW = { yaw: 52, up: 24, down: 50, middle: 0.3 };
// The closest the wheel closes in, as a share of the seat's lens, and how
// fast it goes for the wheel's travel.
var ZOOM_MIN = 0.2;
var ZOOM_RATE = 0.0016;
// Locked on the terminal, the eye comes forward to sit square in front of
// its screen, which then fills the window, and the view holds still.
var DESK_EYE = new Vector3(0, 0.3, 6.6);
var DESK_HALF = { w: 2.35, h: 1.78 };
var LOOK_PITCH_MIN = -70;
var LOOK_PITCH_MAX = 35;

// How long a set stays dark between switching off and coming back with a
// different kind of picture, and how far apart the wall's sets come on.
var SWAP_AFTER_S = 0.9;
var STAGGER_S = 1.4;

// The wall's shape for a number of guests: the smallest of these that
// holds them all. Wide and low, so the wall and the terminal under it fit a
// landscape window together.
var LAYOUTS = [
  [4, 3],
  [8, 3],
  [13, 4],
];

export function wallLayout(guests) {
  for (var i = 0; i < LAYOUTS.length; i++) {
    if (LAYOUTS[i][0] * LAYOUTS[i][1] >= guests) return { columns: LAYOUTS[i][0], rows: LAYOUTS[i][1] };
  }
  var last = LAYOUTS[LAYOUTS.length - 1];
  return { columns: last[0], rows: last[1] };
}

function slab(w, h, d, x, y, z, material) {
  var m = new Mesh(new BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  return m;
}

// options: { guests: how many wall monitors are wanted, nodes: how many
// node monitors on the desk, reducedMotion, always: draw every frame,
// onPick(number), onHover(number or 0), onDeskPress({ col, row }) (return
// true to follow the drag), onDeskDrag({ col, row }), onDeskRelease(),
// onDeskWheel(1 down or -1 up): the wheel over the desk terminal's screen,
// onControl(code): a keypad key clicked, or the dial turned a notch (which
// is the keypad's + or -) }
export function createScene(options) {
  var layout = wallLayout(options.guests);
  var wallCount = layout.columns * layout.rows;
  // A cabinet for each node, as far as there are cabinets.
  var nodeCount = Math.min(options.nodes || 0, 4);
  var reduced = !!options.reducedMotion;

  var canvas = document.createElement("canvas");
  canvas.id = "glCanvas";
  var renderer = new WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: "high-performance" });
  if (!renderer.capabilities.isWebGL2) throw new Error("WebGL2 required");
  if (!renderer.extensions.has("EXT_color_buffer_float") && !renderer.extensions.has("EXT_color_buffer_half_float")) {
    throw new Error("half-float render targets unsupported");
  }
  var shaderFailed = null;
  renderer.debug.onShaderError = function (gl, program, vs, fs) {
    shaderFailed = (gl.getShaderInfoLog(fs) || gl.getShaderInfoLog(vs) || gl.getProgramInfoLog(program) || "shader failed").slice(0, 600);
  };

  var scene = new Scene();
  scene.background = new Color(0x08090a);
  var camera = new PerspectiveCamera(VIEW.seat.fov, 1, 0.5, 400);

  // --- the room ------------------------------------------------------------
  var steel = new MeshStandardMaterial({ color: 0x17191b, roughness: 0.6, metalness: 0.3 });
  var plaster = new MeshStandardMaterial({ color: 0x3b4046, roughness: 0.95 });
  var wood = new MeshStandardMaterial({ color: 0x4a3a2c, roughness: 0.7 });
  var cream = new MeshStandardMaterial({ color: 0xd9d3bd, roughness: 0.6 });
  var floorMat = new MeshStandardMaterial({ color: 0x1c1d1f, roughness: 0.9 });

  var wallW = layout.columns * PITCH_X;
  var wallH = layout.rows * PITCH_Y;
  var wallMidY = WALL_BOTTOM_Y + ((layout.rows - 1) * PITCH_Y) / 2;
  // Where the gear beyond the monitors starts and ends, out from the middle.
  var rackX = wallW / 2 + 0.8 + 0.3 + PANEL.width / 2;
  var rackTop = wallMidY + wallH / 2 + 0.75;
  var boardFrom = rackX + PANEL.width / 2 + 0.3;
  var boardW = BOARD_MACHINES * MACHINE.width;
  var cornerX = boardFrom + boardW + 0.3 + PANEL.width / 2;
  var sideWallX = cornerX + PANEL.width / 2 + 0.3;
  var room = [
    // Back wall and floor.
    slab(260, 120, 1, 0, 30, WALL_Z - 6, plaster),
    slab(260, 1, 160, 0, -16, -20, floorMat),
    slab(1, 120, 160, -(sideWallX + PANEL.depth + 0.3), 30, -20, plaster),
    slab(1, 120, 160, sideWallX + PANEL.depth + 0.3, 30, -20, plaster),
    // The rack the monitors sit in, and the plinth under it.
    slab(wallW + 1.6, wallH + 1.6, 3.6, 0, wallMidY - 0.05, WALL_Z - 2.4, steel),
    slab(wallW + 1.6, WALL_BOTTOM_Y + 16 - PITCH_Y / 2 - 0.8, 3.0, 0, (WALL_BOTTOM_Y - PITCH_Y / 2 - 0.8 - 16) / 2, WALL_Z - 2.7, steel),
    // The desk.
    slab(34, 0.7, 13, 0, DESK_Y - 0.35, 0.5, wood),
  ];
  room.forEach(function (m) {
    scene.add(m);
  });

  scene.add(new AmbientLight(0xbfd0ff, 0.5));
  var ceiling = new DirectionalLight(0xfff1dc, 0.9);
  ceiling.position.set(4, 30, 20);
  scene.add(ceiling);
  // What the desk terminal's picture throws on the desk around it.
  var glow = new PointLight(new Color().fromArray(PHOSPHORS.green), 0, 16, 1.4);
  glow.position.set(0, 0.2, 3.2);
  scene.add(glow);

  // --- the desk terminal ---------------------------------------------------
  var tube = createTube(renderer, { phosphor: options.phosphor });
  scene.add(tube.mesh);
  var deskCabinet = new Mesh(createCabinetGeometry(), cream);
  scene.add(deskCabinet);

  // --- wall and node monitors ----------------------------------------------
  var bank = createBank({
    count: wallCount + nodeCount,
    width: WALL_W,
    height: WALL_H,
    phosphor: options.phosphor,
  });
  scene.add(bank.faces);
  scene.add(bank.cabinets);
  scene.add(bank.leds);

  var matrix = new Matrix4();
  var scale = new Vector3(WALL_SCALE, WALL_SCALE, WALL_SCALE);
  var upright = new Quaternion();
  // Monitor 1 is top left; numbers run along each row, as they are read.
  for (var i = 0; i < wallCount; i++) {
    var col = i % layout.columns;
    var row = Math.floor(i / layout.columns);
    var x = (col - (layout.columns - 1) / 2) * PITCH_X;
    var y = WALL_BOTTOM_Y + (layout.rows - 1 - row) * PITCH_Y;
    bank.place(i, matrix.compose(new Vector3(x, y, WALL_Z), upright, scale));
  }
  // Under the wall, either side of the terminal, stands the computer room:
  // cabinets of lamps and tape drives. The first of them, left to right,
  // each move as one node works; the rest idle.
  var slots = [];
  [-1, 1].forEach(function (side) {
    for (var k = 0; k < MACHINES_A_SIDE; k++) {
      var out = side < 0 ? MACHINES_A_SIDE - 1 - k : k;
      slots.push({ x: side * (MACHINES_FROM + MACHINE.width / 2 + out * MACHINE.width), top: WALL_BOTTOM_Y - PITCH_Y / 2 - 1.0, z: WALL_Z + 0.2 });
    }
  });
  // More cabinets under the boards; these have no node and idle.
  [-1, 1].forEach(function (side) {
    for (var k = 0; k < BOARD_MACHINES; k++) {
      slots.push({ x: side * (boardFrom + MACHINE.width / 2 + k * MACHINE.width), top: WALL_BOTTOM_Y - PITCH_Y / 2 - 1.0, z: WALL_Z + 0.2 });
    }
  });
  var machines = createMachines({ slots: slots, still: reduced });
  scene.add(machines.group);

  // Either side of the wall stands a rack of firing-room gear: a clock, a
  // board of status lamps, meters and a scope. The left one's meters are
  // the nodes' processors and the right one's their memory. Another stands
  // in each corner.
  var panels = createPanels({
    racks: [
      { x: -rackX, top: rackTop, z: WALL_Z + 0.2, clock: "gmt", label: "GMT" },
      { x: rackX, top: rackTop, z: WALL_Z + 0.2, clock: "elapsed", label: "ELAPSED" },
      { x: -cornerX, top: rackTop, z: WALL_Z + 0.2, clock: "local", label: "LOCAL" },
      { x: cornerX, top: rackTop, z: WALL_Z + 0.2, clock: "gmt", label: "GMT" },
    ],
    still: reduced,
  });
  scene.add(panels.group);

  // Between them, over the further cabinets, are the big boards: a
  // tracking chart to the left and the nodes' load to the right. A row of
  // lit signs runs along the top of everything.
  var boardH = rackTop - (WALL_BOTTOM_Y - PITCH_Y / 2 - 1.0) - 0.3;
  var boards = createBoards({
    track: { x: -(boardFrom + boardW / 2), y: rackTop - boardH / 2, z: WALL_Z + 0.2, width: boardW - 0.4, height: boardH },
    trend: { x: boardFrom + boardW / 2, y: rackTop - boardH / 2, z: WALL_Z + 0.2, width: boardW - 0.4, height: boardH },
    nodes: nodeCount,
    signs: { y: rackTop + 1.35, z: WALL_Z + 0.2, width: (sideWallX + PANEL.depth) * 2, height: 2 },
    still: reduced,
  });
  scene.add(boards.group);

  // The side walls, each with racks along it, facing in.
  var sideRacks = [-1, 1].map(function (side) {
    var racks = [];
    for (var k = 0; k < SIDE_RACKS; k++) {
      racks.push({ x: side * (WALL_Z + 0.6 + PANEL.width / 2 + k * (PANEL.width + 0.3)), top: rackTop, z: 0, clock: k ? "elapsed" : "gmt", label: k ? "ELAPSED" : "GMT" });
    }
    var along = createPanels({ racks: racks, still: reduced });
    along.group.position.x = side * (sideWallX - 0.2);
    along.group.rotation.y = (-side * Math.PI) / 2;
    scene.add(along.group);
    return along;
  });

  // Node monitors are a strip of small sets in a sloped panel between the
  // terminal and its keyboard, lying back to face whoever looks down at
  // the keys: there to be glanced at, and nothing selects them.
  if (nodeCount) {
    var sideScale = new Vector3(SIDE_SCALE, SIDE_SCALE, SIDE_SCALE);
    var setW = CABINET.halfW * 2 * SIDE_SCALE;
    var rowW = nodeCount * (setW + SIDE_GAP) + SIDE_GAP;
    var lean = new Quaternion().setFromEuler(new Euler(-SIDE_LEAN, 0, 0));
    // Each set's face sits on the slope; its cabinet goes down into the panel.
    var rise = new Vector3(0, -CABINET.bottom * SIDE_SCALE, 0).applyQuaternion(lean);
    for (var n = 0; n < nodeCount; n++) {
      var where = new Vector3(-rowW / 2 + SIDE_GAP + setW / 2 + n * (setW + SIDE_GAP), DESK_Y + 0.1, SIDE_Z).add(rise);
      bank.place(wallCount + n, matrix.compose(where, lean, sideScale));
    }
  }

  // The switcher: its box beside the terminal, where the seat can read it,
  // and the keypad and dial on the desk to the right of the node monitors.
  var controls = createControls({
    deskY: DESK_Y,
    box: { x: 5.2, z: -2.4, turn: -0.3 },
    keypad: { x: 4.3, z: 1.5 },
    dial: { x: 7.2, z: 1.5 },
    lock: { x: -3.6, z: 1.9, turn: 0.12 },
  });
  scene.add(controls.group);

  // Somebody's lava lamp, on the other side of the terminal from the box.
  var lavaLamp = createLavaLamp({ x: -5.4, y: DESK_Y, z: -2.2, still: reduced });
  scene.add(lavaLamp.group);

  // What a shift leaves lying about, on the bare ends of the desk.
  var props = createProps({
    deskY: DESK_Y,
    logbook: { x: -7.2, z: 3.4, turn: 0.22 },
    mug: { x: -9.6, z: 1.2 },
    headset: { x: 10.4, z: 3.6, turn: -0.5 },
    lamp: { x: 14.6, z: -1.6, turn: 3.75 },
  });
  scene.add(props.group);

  // Each lamp has a switch in its cord, lying on the desk in front of it.
  var lavaSwitch = createCordSwitch({
    x: -4.6,
    y: DESK_Y,
    z: -0.6,
    turn: 0.35,
    fromLamp: [[-5.25, -1.62]],
    toWall: [
      [-3.95, 0.25],
      [-3.35, -0.7],
      [-3.45, -3.4],
      [-3.7, -6],
    ],
  });
  var lampSwitch = createCordSwitch({
    x: 12.7,
    y: DESK_Y,
    z: 0.9,
    turn: -0.47,
    fromLamp: [[13.55, -0.75]],
    toWall: [
      [11.75, 2.0],
      [10.95, 0.7],
      [11.2, -3.2],
      [11.6, -6],
    ],
  });
  scene.add(lavaSwitch.group, lampSwitch.group);

  // The terminal's keyboard, in front of it.
  var keyboard = createKeyboard({ x: 0, y: DESK_Y, z: 4.6, width: 7.6, material: cream });
  scene.add(keyboard.group);

  // --- what is on each screen ----------------------------------------------
  // kind: "off" (a spare set), or any name for what it shows. A set that
  // changes kind - a guest going offline, say - switches off and comes back
  // with the new picture; a change within a kind is just redrawn.
  var screens = [];
  for (var s = 0; s < bank.count; s++) {
    screens.push({ kind: null, key: "", delay: 0, pending: null, pendingLevel: 0, pendingKey: "" });
  }
  var scratch = new Uint8Array(WALL_W * WALL_H);

  function show(index, grid, kind) {
    var st = screens[index];
    if (kind === "off") {
      if (st.kind !== "off") {
        var never = st.kind === null;
        st.kind = "off";
        st.key = "";
        st.pending = null;
        st.delay = 0;
        bank.setPower(index, false, reduced || never);
        bank.setLed(index, "off");
        wake(7);
      }
      return;
    }
    var key = grid.key();
    if (st.kind === kind && st.key === key && !st.pending) return;
    if (st.pending && st.pendingKey === key && st.kind === kind) return;
    var first = st.kind === null || st.kind === "off";
    if (!first && st.kind !== kind && !reduced) {
      // Off, then back on with the new picture once the raster has folded.
      st.pendingLevel = paintGrid(grid, scratch, WALL_W, WALL_H, WALL_TEXT_SCALE);
      st.pending = st.pending || new Uint8Array(WALL_W * WALL_H);
      st.pending.set(scratch);
      st.pendingKey = key;
      st.kind = kind;
      bank.setPower(index, false);
      wake(SWAP_AFTER_S + 4);
      return;
    }
    if (st.pending) {
      // Still dark from a change of kind: update what it will come back with.
      st.pendingLevel = paintGrid(grid, st.pending, WALL_W, WALL_H, WALL_TEXT_SCALE);
      st.pendingKey = key;
      return;
    }
    bank.changed(index, paintGrid(grid, bank.signal(index), WALL_W, WALL_H, WALL_TEXT_SCALE));
    st.key = key;
    st.kind = kind;
    if (first) {
      bank.setLed(index, selected === index + 1 ? "selected" : "on");
      if (reduced) bank.setPower(index, true, true);
      // The wall comes on a set at a time, not all at once.
      else st.delay = 0.05 + ((index * 0.6180339887) % 1) * STAGGER_S;
    }
    wake(4);
  }

  function stepScreens(dt) {
    var moving = false;
    for (var i = 0; i < screens.length; i++) {
      var st = screens[i];
      if (st.delay > 0) {
        st.delay -= dt;
        moving = true;
        if (st.delay <= 0) bank.setPower(i, true);
      }
      if (st.pending) {
        moving = true;
        var p = bank.power(i);
        if (p.state === "off" || (p.state === "collapsing" && p.t >= SWAP_AFTER_S)) {
          bank.signal(i).set(st.pending);
          bank.changed(i, st.pendingLevel);
          st.key = st.pendingKey;
          st.pending = null;
          bank.setPower(i, true);
        }
      }
    }
    return moving;
  }

  var deskKey = "";
  function showDesk(grid) {
    var key = grid.key();
    if (key === deskKey) return;
    deskKey = key;
    tube.changed(paintGrid(grid, tube.signal, tube.width, tube.height, 1));
    // Long enough for the slow phosphor component to fade out.
    wake(DECAY_SLOW_S * 6);
  }

  var selected = 0;
  function setSelected(number) {
    if (selected && screens[selected - 1].kind !== "off" && screens[selected - 1].kind !== null) bank.setLed(selected - 1, "on");
    selected = number;
    if (selected && screens[selected - 1].kind !== "off") bank.setLed(selected - 1, "selected");
    wake(0.5);
  }

  // --- the view ------------------------------------------------------------
  // The head follows the pointer: the view turns toward wherever in the
  // window the pointer is, a little near the middle and more toward the
  // edges, so the whole room can be reached with nothing held down. The
  // wheel closes in and backs off, and what it is closed in on stays so. A
  // right click holds the view where it is, and another lets it go.
  // Where the pointer is in the window, -1..1 each way (up is positive).
  var pointer = { x: 0, y: 0, clientX: 0, clientY: 0, seen: false };
  // How far closed in: 1 is the seat's own lens, ZOOM_MIN the closest.
  var zoom = 1;
  // What closing in at a point away from the middle has turned the view
  // by, and what a finger has dragged it by (degrees).
  var zoomOff = { yaw: 0, pitch: 0 };
  var touchOff = { yaw: 0, pitch: 0 };
  // The view held still: { yaw, pitch }, or null while it follows.
  var seatHold = { yaw: 0, pitch: VIEW.seat.pitch };
  var hold = reduced ? { yaw: seatHold.yaw, pitch: seatHold.pitch } : null;
  var deskLock = false;
  var deskNear = 0; // 0 at the seat .. 1 in front of the terminal
  // The view as it is drawn, and the one it is easing to (degrees).
  var cur = { yaw: 0, pitch: VIEW.seat.pitch, fov: VIEW.seat.fov };
  var goal = { yaw: 0, pitch: VIEW.seat.pitch, fov: VIEW.seat.fov };
  var settled = false;
  var target = new Vector3();
  // Where the room's furnishing ends, as the eye sees it (degrees): the
  // near end of the racks along the side walls, the top of the signs, and
  // the desk's front edge.
  var EDGE = {
    side: (Math.atan2(sideWallX, EYE.z - (WALL_Z + 0.6 + SIDE_RACKS * (PANEL.width + 0.3))) * 180) / Math.PI + 2,
    top: (Math.atan2(rackTop + 2.35 - EYE.y, EYE.z - WALL_Z) * 180) / Math.PI + 2,
    bottom: (Math.atan2(DESK_Y - EYE.y, EYE.z - 7) * 180) / Math.PI + 2,
  };

  function fovFor(view, aspect) {
    // In a narrow window the lens widens until the wall (or the terminal)
    // still fits across it.
    var halfWidth = view === VIEW.seat ? (wallW / 2 + 1.2) / (EYE.z - WALL_Z) : 4.4 / EYE.z;
    var need = (2 * Math.atan(halfWidth / aspect) * 180) / Math.PI;
    return Math.max(view.fov, Math.min(need, 100));
  }

  // How far the head turns for a pointer this far from the middle.
  function follow(n) {
    return n * (FOLLOW.middle + (1 - FOLLOW.middle) * n * n);
  }

  function setGoal() {
    if (deskLock) {
      var need = Math.max(DESK_HALF.h / DESK_EYE.z, DESK_HALF.w / DESK_EYE.z / camera.aspect);
      goal.fov = (2 * Math.atan(need) * 180) / Math.PI;
      goal.yaw = 0;
      goal.pitch = (Math.atan2(-DESK_EYE.y, DESK_EYE.z) * 180) / Math.PI;
      return;
    }
    goal.fov = fovFor(VIEW.seat, camera.aspect) * zoom;
    // A selection being dragged across the terminal keeps the view still.
    if (pressing) return;
    // The bumpers: the view stops where its edge meets the end of the
    // room's furnishing, so the further it is closed in the further it turns.
    var halfV = goal.fov / 2;
    var halfH = (Math.atan(Math.tan((halfV * Math.PI) / 180) * camera.aspect) * 180) / Math.PI;
    var yawMax = Math.max(0, Math.min(LOOK_YAW_MAX, EDGE.side - halfH));
    var pitchMax = Math.min(LOOK_PITCH_MAX, EDGE.top - halfV);
    var pitchMin = Math.max(LOOK_PITCH_MIN, EDGE.bottom + halfV);
    if (pitchMin > pitchMax) pitchMin = pitchMax = Math.max(pitchMax, Math.min(pitchMin, VIEW.seat.pitch));
    var yaw;
    var pitch;
    if (hold) {
      yaw = hold.yaw;
      pitch = hold.pitch;
    } else {
      var level = Math.max(pitchMin, Math.min(pitchMax, VIEW.seat.pitch));
      yaw = follow(pointer.x) * Math.min(FOLLOW.yaw, yawMax) + zoomOff.yaw + touchOff.yaw;
      pitch = level + follow(pointer.y) * (pointer.y > 0 ? Math.min(FOLLOW.up, pitchMax - level) : Math.min(FOLLOW.down, level - pitchMin)) + zoomOff.pitch + touchOff.pitch;
    }
    goal.yaw = Math.max(-yawMax, Math.min(yawMax, yaw));
    goal.pitch = Math.max(pitchMin, Math.min(pitchMax, pitch));
    // What a bumper stopped is given up, so that coming back off it is
    // felt at once.
    if (hold) {
      hold.yaw = goal.yaw;
      hold.pitch = goal.pitch;
    } else {
      var spare = touching ? touchOff : zoomOff;
      spare.yaw -= yaw - goal.yaw;
      spare.pitch -= pitch - goal.pitch;
    }
  }

  function setDeskLock(on) {
    if (on === deskLock) return;
    controls.setLock(on);
    deskLock = on;
    wake(1.5);
  }

  function setHold(to) {
    hold = to;
    // Let go, the view is the pointer's again, with nothing left over.
    if (!hold) zoomOff.yaw = zoomOff.pitch = touchOff.yaw = touchOff.pitch = 0;
    if (options.onHold) options.onHold(!!hold);
    wake(1.5);
  }

  // Back to the seat's own view: nothing closed in on, nothing held.
  function resetView() {
    zoom = 1;
    zoomOff.yaw = zoomOff.pitch = touchOff.yaw = touchOff.pitch = 0;
    hold = reduced ? { yaw: seatHold.yaw, pitch: seatHold.pitch } : null;
    wake(1.5);
  }

  function aim() {
    if (camera.fov !== cur.fov) {
      camera.fov = cur.fov;
      camera.updateProjectionMatrix();
    }
    camera.position.copy(EYE);
    if (deskNear) camera.position.lerp(DESK_EYE, deskNear * deskNear * (3 - 2 * deskNear));
    var yaw = (cur.yaw * Math.PI) / 180;
    var r = (cur.pitch * Math.PI) / 180;
    target.set(camera.position.x + Math.sin(yaw) * Math.cos(r) * 10, camera.position.y + Math.sin(r) * 10, camera.position.z - Math.cos(yaw) * Math.cos(r) * 10);
    camera.lookAt(target);
  }

  // Closes in (`by` below 1) or backs off (above 1), keeping what is under
  // the pointer under it as the picture grows.
  function zoomBy(ev, by) {
    var was = zoom;
    var next = Math.max(ZOOM_MIN, Math.min(1, zoom * by));
    if (next === was || pressing) return;
    zoom = next;
    var rect = canvas.getBoundingClientRect();
    var nx = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    var ny = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    var wide = fovFor(VIEW.seat, camera.aspect);
    var t0 = Math.tan((wide * was * Math.PI) / 360);
    var t1 = Math.tan((wide * next * Math.PI) / 360);
    var dyaw = ((Math.atan(nx * t0 * camera.aspect) - Math.atan(nx * t1 * camera.aspect)) * 180) / Math.PI;
    var dpitch = ((Math.atan(ny * t0) - Math.atan(ny * t1)) * 180) / Math.PI;
    if (hold) {
      hold.yaw += dyaw;
      hold.pitch += dpitch;
    } else if (next === 1) {
      // Right back, the seat's lens is the seat's view.
      zoomOff.yaw = zoomOff.pitch = 0;
    } else {
      // The view should turn by just that much. How far it follows the
      // pointer changes with the lens too, so that is taken out again.
      zoom = was;
      setGoal();
      var yaw = goal.yaw + dyaw;
      var pitch = goal.pitch + dpitch;
      zoom = next;
      setGoal();
      zoomOff.yaw += yaw - goal.yaw;
      zoomOff.pitch += pitch - goal.pitch;
    }
    wake(1.5);
  }

  function stepView(dt) {
    var moving = false;
    var nearGoal = deskLock ? 1 : 0;
    if (deskNear !== nearGoal) {
      deskNear = reduced || Math.abs(nearGoal - deskNear) < 0.002 ? nearGoal : deskNear + (nearGoal - deskNear) * (1 - Math.exp(-dt / 0.22));
      moving = true;
    }
    setGoal();
    var off = Math.abs(goal.yaw - cur.yaw) + Math.abs(goal.pitch - cur.pitch) + Math.abs(goal.fov - cur.fov);
    if (off) {
      var k = reduced || off < 0.01 ? 1 : 1 - Math.exp(-dt / (deskLock || deskNear ? 0.16 : 0.1));
      cur.yaw += (goal.yaw - cur.yaw) * k;
      cur.pitch += (goal.pitch - cur.pitch) * k;
      cur.fov += (goal.fov - cur.fov) * k;
      moving = true;
    }
    aim();
    // The room has moved under a pointer that has not.
    if (moving && pointer.seen && !pressing && !touching) hover(pointer);
    return moving;
  }

  function layoutCanvas() {
    var w = window.innerWidth;
    var h = window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
    setGoal();
    if (!settled || reduced) {
      settled = true;
      cur.yaw = goal.yaw;
      cur.pitch = goal.pitch;
      cur.fov = goal.fov;
    }
    aim();
    wake(0.3);
  }

  // --- pointer -------------------------------------------------------------
  var raycaster = new Raycaster();
  var ndc = new Vector2();
  var lavaPicks = lavaSwitch.pickables.concat(lavaLamp.pickables);
  var lampPicks = lampSwitch.pickables.concat(props.lampPickables);
  var pickable = [bank.faces, bank.cabinets, tube.mesh, deskCabinet].concat(room, controls.pickables, lavaPicks, lampPicks);

  // The wall monitor number under a point of the window, or 0. The ray is
  // tested against the whole room, so the terminal in front of a monitor
  // takes the click instead of it.
  function monitorAt(ev) {
    var rect = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    var hits = raycaster.intersectObjects(pickable, false);
    if (!hits.length) return 0;
    var hit = hits[0];
    if ((hit.object === bank.faces || hit.object === bank.cabinets) && hit.instanceId !== undefined && hit.instanceId < wallCount) {
      return screens[hit.instanceId].kind === "off" || screens[hit.instanceId].kind === null ? 0 : hit.instanceId + 1;
    }
    return 0;
  }

  // Which character cell of the desk terminal is under the pointer, or
  // null where it is not on the tube's face. A point on the face but outside
  // the picture gives the nearest cell.
  function deskCellAt(ev) {
    var rect = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    var hits = raycaster.intersectObjects(pickable, false);
    if (!hits.length || hits[0].object !== tube.mesh) return null;
    var dir = raycaster.ray.direction;
    var face = faceHit(hits[0].point.x, hits[0].point.y, dir.x, dir.y, dir.z);
    if (!face) return null;
    var at = faceToRaster(face.px, face.py);
    return {
      col: Math.max(0, Math.min(RASTER.cols - 1, Math.floor(at.u * RASTER.cols))),
      row: Math.max(0, Math.min(RASTER.rows - 1, Math.floor(at.v * RASTER.rows))),
    };
  }

  // A press on the desk terminal's screen and the drag that follows it are
  // a selection of its text, which is the page's business.
  var pressing = false;
  // A finger down: where it began and last was, and whether it has moved
  // far enough to be a drag of the view and not a tap.
  var touching = null;
  function track(ev) {
    if (ev.pointerType === "touch") return;
    var rect = canvas.getBoundingClientRect();
    pointer.x = Math.max(-1, Math.min(1, ((ev.clientX - rect.left) / rect.width) * 2 - 1));
    pointer.y = Math.max(-1, Math.min(1, -((ev.clientY - rect.top) / rect.height) * 2 + 1));
    pointer.clientX = ev.clientX;
    pointer.clientY = ev.clientY;
    pointer.seen = true;
  }
  function onUp(ev) {
    if (touching && ev.pointerId === touching.id) {
      var tap = !touching.moved && ev.type === "pointerup";
      var at = { clientX: touching.startX, clientY: touching.startY };
      touching = null;
      if (canvas.hasPointerCapture && canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
      if (tap) press(at);
      return;
    }
    if (!pressing) return;
    pressing = false;
    if (canvas.hasPointerCapture && canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
    if (options.onDeskRelease) options.onDeskRelease();
  }

  // The key a click here would press: one of the keypad's, or the dial's
  // next and previous. Null anywhere else.
  function controlAt(ev, hovering) {
    var rect = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    var hits = raycaster.intersectObjects(pickable, false);
    if (!hits.length) return null;
    // The plate under the dial takes the wheel, though a click on it does nothing.
    if (lavaPicks.indexOf(hits[0].object) >= 0) return "LavaLamp";
    if (lampPicks.indexOf(hits[0].object) >= 0) return "DeskLamp";
    return controls.codeAt(hits[0]) || (hovering && controls.onDial(hits[0]) ? "dial" : null);
  }

  // The wheel over the dial turns it, a notch at a time; over the
  // terminal's screen it is the terminal's; anywhere else it closes in on
  // what is under the pointer, or backs off.
  var lastNotch = 0;
  function onWheel(ev) {
    ev.preventDefault();
    if (!ev.deltaY) return;
    track(ev);
    var rect = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    var hits = raycaster.intersectObjects(pickable, false);
    var dial = hits.length > 0 && controls.onDial(hits[0]);
    if (dial || deskCellAt(ev)) {
      if (ev.timeStamp - lastNotch < 70) return;
      lastNotch = ev.timeStamp;
      if (dial) {
        if (options.onControl) options.onControl(ev.deltaY > 0 ? "NumpadAdd" : "NumpadSubtract");
      } else if (options.onDeskWheel) options.onDeskWheel(ev.deltaY > 0 ? 1 : -1);
      return;
    }
    if (deskLock) return;
    // A notch of a wheel is about 100; a trackpad sends many small ones.
    var delta = ev.deltaY * (ev.deltaMode === 1 ? 33 : ev.deltaMode === 2 ? 300 : 1);
    zoomBy(ev, Math.exp(Math.max(-300, Math.min(300, delta)) * ZOOM_RATE));
  }

  var hovered = 0;
  var overControl = false;
  function onMove(ev) {
    if (pressing) {
      var cell = deskCellAt(ev);
      if (cell && options.onDeskDrag) options.onDeskDrag(cell);
      wake(1);
      return;
    }
    if (touching) {
      if (ev.pointerId !== touching.id) return;
      if (!touching.moved && Math.abs(ev.clientX - touching.startX) + Math.abs(ev.clientY - touching.startY) > 10) touching.moved = true;
      if (touching.moved && !deskLock) {
        // The scene is dragged, as a thing held: the head turns the other way.
        var perPixel = cur.fov / Math.max(window.innerHeight, 1);
        var to = hold || touchOff;
        to.yaw = Math.max(-LOOK_YAW_MAX, Math.min(LOOK_YAW_MAX, to.yaw - (ev.clientX - touching.x) * perPixel));
        to.pitch = Math.max(LOOK_PITCH_MIN, Math.min(LOOK_PITCH_MAX, to.pitch + (ev.clientY - touching.y) * perPixel));
      }
      touching.x = ev.clientX;
      touching.y = ev.clientY;
      return wake(1);
    }
    track(ev);
    hover(ev);
    wake(1);
  }
  function hover(ev) {
    var over = monitorAt(ev);
    var control = !over && !!controlAt(ev, true);
    if (over !== hovered || control !== overControl) {
      var was = hovered;
      hovered = over;
      overControl = control;
      canvas.style.cursor = over || control ? "pointer" : "";
      if (over !== was && options.onHover) options.onHover(over);
    }
  }
  // Whether the terminal's case is what is under the pointer.
  function caseAt(ev) {
    var rect = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    var hits = raycaster.intersectObjects(pickable, false);
    return hits.length > 0 && hits[0].object === deskCabinet;
  }
  // A click or a tap: a monitor is picked, a control worked. True if it
  // landed on either.
  function press(ev) {
    var over = monitorAt(ev);
    if (over && options.onPick) {
      options.onPick(over);
      return true;
    }
    var code = controlAt(ev);
    // The lamps' switches are the room's own business.
    if (code === "LavaLamp" || code === "DeskLamp") {
      if (code === "LavaLamp") {
        lavaLamp.setOn(!lavaLamp.on());
        lavaSwitch.set(lavaLamp.on());
      } else {
        props.setLamp(!props.lampOn());
        lampSwitch.set(props.lampOn());
      }
      wake(2);
      return true;
    }
    if (code && options.onControl) {
      options.onControl(code);
      return true;
    }
    // The terminal's own case: the view locks on to it, or lets go.
    if (caseAt(ev) && options.onControl) {
      options.onControl("Lock");
      return true;
    }
    return false;
  }
  function onDown(ev) {
    if (ev.pointerType === "touch") {
      // A finger may be a tap or the start of a drag: which, is known when
      // it lifts.
      if (!touching) {
        touching = { id: ev.pointerId, startX: ev.clientX, startY: ev.clientY, x: ev.clientX, y: ev.clientY, moved: false };
        if (canvas.setPointerCapture) canvas.setPointerCapture(ev.pointerId);
      }
      return;
    }
    track(ev);
    // The right button holds the view where it is, or lets it go.
    if (ev.button === 2) {
      ev.preventDefault();
      // A room that keeps still stays held: there the right button drags
      // the view round instead.
      if (reduced && !deskLock) {
        touching = { id: ev.pointerId, startX: ev.clientX, startY: ev.clientY, x: ev.clientX, y: ev.clientY, moved: true };
        if (canvas.setPointerCapture) canvas.setPointerCapture(ev.pointerId);
        return;
      }
      // Locked on the terminal, it lets go.
      if (deskLock) {
        if (options.onControl) options.onControl("Lock");
        return;
      }
      setGoal();
      return setHold(hold ? null : { yaw: goal.yaw, pitch: goal.pitch });
    }
    if (ev.button !== 0) return;
    if (press(ev)) return;
    var cell = deskCellAt(ev);
    if (cell && options.onDeskPress && options.onDeskPress(cell)) {
      pressing = true;
      if (canvas.setPointerCapture) canvas.setPointerCapture(ev.pointerId);
    }
  }
  function onMenu(ev) {
    ev.preventDefault();
  }
  // Twice on nothing in particular: back to the seat's own view.
  function onDouble(ev) {
    if (deskLock || monitorAt(ev) || controlAt(ev) || deskCellAt(ev) || caseAt(ev)) return;
    resetView();
    if (options.onHold) options.onHold(!!hold);
  }
  canvas.addEventListener("contextmenu", onMenu);
  canvas.addEventListener("dblclick", onDouble);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("resize", layoutCanvas);

  // --- frames --------------------------------------------------------------
  // The scene is only redrawn while something is changing, and for a moment
  // after: a wall of still pictures costs nothing.
  var activeUntil = 0;
  function wake(seconds) {
    activeUntil = Math.max(activeUntil, performance.now() / 1000 + seconds);
  }

  // A room that keeps still sleeps between changes, but its clocks must
  // not stop: a frame a second keeps them right.
  var tick = reduced
    ? setInterval(function () {
        wake(0.1);
      }, 1000)
    : 0;

  var lastTime = performance.now() / 1000;
  var dead = false;
  var frames = 0;
  var fps = 0;
  var fpsFrames = 0;
  var fpsSince = lastTime;
  var screenLevel = 0;
  var rafId = 0;

  function frame(ms) {
    if (dead) return;
    rafId = requestAnimationFrame(frame);
    var now = ms / 1000;
    var dt = Math.min(Math.max(now - lastTime, 0), 0.25);
    lastTime = now;
    if (document.hidden) return;
    if (!options.always && now > activeUntil && frames > 0) return;

    var moving = false;
    if (stepScreens(dt)) moving = true;
    if (bank.update(dt)) moving = true;
    if (tube.update(dt)) moving = true;
    if (stepView(dt)) moving = true;
    if (machines.update(dt)) moving = true;
    if (controls.update(dt, reduced)) moving = true;
    if (keyboard.update(dt)) moving = true;
    if (panels.update(dt)) moving = true;
    if (boards.update(dt)) moving = true;
    sideRacks.forEach(function (along) {
      if (along.update(dt)) moving = true;
    });
    if (lavaLamp.update(dt)) moving = true;
    if (props.update(dt, reduced)) moving = true;
    if (lavaSwitch.update(dt, reduced)) moving = true;
    if (lampSwitch.update(dt, reduced)) moving = true;

    // The terminal lighting the desk, following the phosphor rather than
    // the signal: it keeps giving light for a moment after the beam moves on.
    var level = tube.light();
    screenLevel += (level - screenLevel) * (1 - Math.exp(-dt / 0.3));
    if (Math.abs(level - screenLevel) < 0.0002) screenLevel = level;
    else moving = true;
    glow.intensity = GLASS_T * EMISSION_GAIN * screenLevel * 70;

    if (moving) wake(0.1);
    renderer.render(scene, camera);
    frames++;
    fpsFrames++;
    if (now - fpsSince >= 1) {
      fps = fpsFrames / (now - fpsSince);
      fpsFrames = 0;
      fpsSince = now;
    }
  }

  layoutCanvas();
  tube.setPower(true, reduced);
  wake(6);
  rafId = requestAnimationFrame(frame);

  var projected = new Vector3();
  return {
    canvas: canvas,
    columns: layout.columns,
    rows: layout.rows,
    wallCount: wallCount,
    nodeCount: nodeCount,
    // Puts a 13 x 4 grid on wall monitor `number` (from 1), or node monitor
    // `number` with node: true.
    show: function (number, grid, kind, node) {
      show((node ? wallCount : 0) + number - 1, grid, kind);
    },
    // Puts an 80 x 25 grid on the desk terminal.
    showDesk: showDesk,
    // How hard node `number` is working (0..1, or -1 when it is down),
    // which one cabinet's lamps and tape reels follow, and how full its
    // memory is (0..1); each also has a meter in the racks beside the wall.
    setNodeLoad: function (number, load, memory) {
      machines.setLoad(number - 1, load);
      panels.setMeter(0, number - 1, Math.max(0, load));
      boards.setLoad(number - 1, load);
      panels.setMeter(1, number - 1, memory === undefined ? null : memory);
    },
    deskCellAt: deskCellAt,
    controlAt: controlAt,
    // The switcher: two characters on its readout; where its dial points
    // (monitor `number` of `count`); the selected guest's power lamp ("on",
    // "off" or null); and a keypad key going down.
    setReadout: function (text) {
      if (controls.setReadout(text)) wake(0.3);
    },
    setDial: function (number, count) {
      controls.setDial(number, count);
      wake(0.6);
    },
    setPower: function (power, thrown) {
      controls.setPower(power, thrown);
      wake(0.3);
    },
    // Lifts the guard over the power switch, or shuts it.
    setGuard: function (open) {
      controls.setGuard(open);
      wake(0.6);
    },
    pressKey: function (code) {
      controls.press(code);
      wake(0.6);
    },
    // A key of the terminal's keyboard going down.
    typeKey: function (code) {
      if (keyboard.press(code)) wake(0.6);
    },
    setSelected: setSelected,
    // "seat" gives the view back to the pointer, with nothing closed in on;
    // "keys" turns the head down to the keyboard and holds it there; "desk"
    // comes in close to the terminal and holds; null lets that go.
    setView: function (view) {
      setDeskLock(view === "desk");
      if (view === "seat") resetView();
      else if (view === "keys") hold = { yaw: 0, pitch: VIEW.keys.pitch };
      wake(1.5);
    },
    // "desk" while locked on the terminal; "held" while the view is held
    // still; else "follow".
    view: function () {
      return deskLock ? "desk" : hold ? "held" : "follow";
    },
    wake: wake,
    stats: function () {
      var info = renderer.info;
      return {
        fps: fps,
        frames: frames,
        calls: info.render.calls,
        triangles: info.render.triangles,
        shaderError: shaderFailed,
        monitors: bank.count,
      };
    },
    // Where wall monitor `number` is in the window, for tests that click it.
    monitorPosition: function (number) {
      var col = (number - 1) % layout.columns;
      var row = Math.floor((number - 1) / layout.columns);
      projected.set((col - (layout.columns - 1) / 2) * PITCH_X, WALL_BOTTOM_Y + (layout.rows - 1 - row) * PITCH_Y, WALL_Z).project(camera);
      var rect = canvas.getBoundingClientRect();
      return { x: rect.left + ((projected.x + 1) / 2) * rect.width, y: rect.top + ((1 - projected.y) / 2) * rect.height };
    },
    dispose: function () {
      dead = true;
      cancelAnimationFrame(rafId);
      if (tick) clearInterval(tick);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onMenu);
      canvas.removeEventListener("dblclick", onDouble);
      window.removeEventListener("resize", layoutCanvas);
      tube.dispose();
      bank.dispose();
      machines.dispose();
      controls.dispose();
      keyboard.dispose();
      props.dispose();
      panels.dispose();
      boards.dispose();
      sideRacks.forEach(function (along) {
        along.dispose();
      });
      lavaLamp.dispose();
      lavaSwitch.dispose();
      lampSwitch.dispose();
      room.forEach(function (m) {
        m.geometry.dispose();
      });
      [steel, plaster, wood, cream, floorMat].forEach(function (m) {
        m.dispose();
      });
      deskCabinet.geometry.dispose();
      renderer.dispose();
    },
  };
}
