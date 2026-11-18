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
  // Turned to one side of the desk: to the right are the switcher box,
  // the keypad and the dial.
  side: { pitch: -25, yaw: 27, fov: 44 },
};
// The view is the viewer's to move: dragging turns the head, this far
// either way and this far up and down (degrees), and it stays where it is
// left.
var LOOK_YAW_MAX = 85;
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
    lamp: { x: -9.4, z: -3.2, turn: 0.5 },
  });
  scene.add(props.group);

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
  // Where the head is turned (degrees), and where it is turning to.
  var look = { yaw: 0, pitch: VIEW.seat.pitch };
  var lookGoal = { yaw: 0, pitch: VIEW.seat.pitch };
  function lookTo(yaw, pitch) {
    lookGoal.yaw = Math.max(-LOOK_YAW_MAX, Math.min(LOOK_YAW_MAX, yaw));
    lookGoal.pitch = Math.max(LOOK_PITCH_MIN, Math.min(LOOK_PITCH_MAX, pitch));
  }
  // Closing in on the wall: how far (a step of ZOOM_STEPS), the view that
  // is, the one it is easing to, and the one it left and goes back to.
  var zoomLevel = 0;
  var zoomed = false;
  var zoomView = { pitch: 0, yaw: 0, fov: 0 };
  var zoomGoal = { pitch: 0, yaw: 0, fov: 0 };
  var baseView = { pitch: 0, yaw: 0, fov: 0 };
  var deskLock = false;
  var deskNear = 0; // 0 at the seat .. 1 in front of the terminal
  function aimAtDesk() {
    var need = Math.max(DESK_HALF.h / DESK_EYE.z, DESK_HALF.w / DESK_EYE.z / camera.aspect);
    zoomGoal.fov = (2 * Math.atan(need) * 180) / Math.PI;
    zoomGoal.yaw = 0;
    zoomGoal.pitch = (Math.atan2(-DESK_EYE.y, DESK_EYE.z) * 180) / Math.PI;
  }
  function setDeskLock(on) {
    if (on === deskLock) return;
    controls.setLock(on);
    if (on && !zoomed) {
      zoomView.pitch = baseView.pitch;
      zoomView.yaw = baseView.yaw;
      zoomView.fov = baseView.fov;
      zoomed = true;
    }
    deskLock = on;
    zoomLevel = 0;
    wake(1.5);
  }
  var target = new Vector3();

  function fovFor(view, aspect) {
    // In a narrow window the lens widens until the wall (or the terminal)
    // still fits across it.
    var halfWidth = view === VIEW.seat ? (wallW / 2 + 1.2) / (EYE.z - WALL_Z) : 4.4 / EYE.z;
    var need = (2 * Math.atan(halfWidth / aspect) * 180) / Math.PI;
    return Math.max(view.fov, Math.min(need, 100));
  }

  function aim() {
    var pitch = look.pitch;
    var yaw = (look.yaw * Math.PI) / 180;
    var fov = fovFor(VIEW.seat, camera.aspect);
    baseView.pitch = pitch;
    baseView.yaw = yaw;
    baseView.fov = fov;
    if (zoomed) {
      pitch = zoomView.pitch;
      yaw = zoomView.yaw;
      fov = zoomView.fov;
    }
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    camera.position.copy(EYE);
    if (deskNear) camera.position.lerp(DESK_EYE, deskNear * deskNear * (3 - 2 * deskNear));
    var r = (pitch * Math.PI) / 180;
    target.set(camera.position.x + Math.sin(yaw) * Math.cos(r) * 10, camera.position.y + Math.sin(r) * 10, camera.position.z - Math.cos(yaw) * Math.cos(r) * 10);
    camera.lookAt(target);
  }

  // Closes in on the wall (`by` 1) or backs off (-1), keeping what is
  // under the pointer under it.
  function zoomAt(ev, by) {
    var level = Math.max(0, Math.min(ZOOM_STEPS.length - 1, zoomLevel + by));
    if (level === zoomLevel) return;
    if (!zoomed) {
      // It starts from the view as it stands.
      zoomView.pitch = baseView.pitch;
      zoomView.yaw = baseView.yaw;
      zoomView.fov = baseView.fov;
      zoomed = true;
    }
    zoomLevel = level;
    if (!level) return wake(1);
    var rect = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    var ray = raycaster.ray;
    var t = (WALL_Z - ray.origin.z) / ray.direction.z;
    var px = ray.origin.x + ray.direction.x * t - camera.position.x;
    var py = ray.origin.y + ray.direction.y * t - camera.position.y;
    var pz = EYE.z - WALL_Z;
    zoomGoal.fov = fovFor(VIEW.seat, camera.aspect) * ZOOM_STEPS[level];
    var half = Math.tan((zoomGoal.fov * Math.PI) / 360);
    // Where that point is from the eye, less how far off the middle of
    // the picture the pointer is.
    zoomGoal.yaw = Math.atan2(px, pz) - Math.atan(ndc.x * half * camera.aspect);
    zoomGoal.pitch = ((Math.atan2(py, Math.sqrt(px * px + pz * pz)) - Math.atan(ndc.y * half)) * 180) / Math.PI;
    wake(1);
  }

  // Whether the pointer is over the wall of monitors.
  function overWall(ev) {
    var rect = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    var hits = raycaster.intersectObjects(pickable, false);
    return hits.length > 0 && (hits[0].object === bank.faces || hits[0].object === bank.cabinets || hits[0].object === room[2]) && hits[0].point.z < WALL_Z + 6;
  }

  function stepView(dt) {
    var moving = false;
    var nearGoal = deskLock ? 1 : 0;
    if (deskNear !== nearGoal) {
      deskNear = reduced || Math.abs(nearGoal - deskNear) < 0.002 ? nearGoal : deskNear + (nearGoal - deskNear) * (1 - Math.exp(-dt / 0.22));
      moving = true;
    }
    if (zoomed) {
      if (deskLock) aimAtDesk();
      var to = zoomLevel || deskLock ? zoomGoal : baseView;
      var k = reduced ? 1 : 1 - Math.exp(-dt / 0.16);
      zoomView.pitch += (to.pitch - zoomView.pitch) * k;
      zoomView.yaw += (to.yaw - zoomView.yaw) * k;
      zoomView.fov += (to.fov - zoomView.fov) * k;
      var off = Math.abs(to.pitch - zoomView.pitch) + Math.abs(to.yaw - zoomView.yaw) * 57 + Math.abs(to.fov - zoomView.fov);
      if (off < 0.02) {
        zoomView.pitch = to.pitch;
        zoomView.yaw = to.yaw;
        zoomView.fov = to.fov;
        if (!zoomLevel && !deskLock) zoomed = false;
      } else moving = true;
    }
    if (look.yaw !== lookGoal.yaw || look.pitch !== lookGoal.pitch) {
      var ease = reduced ? 1 : 1 - Math.exp(-dt / 0.07);
      look.yaw += (lookGoal.yaw - look.yaw) * ease;
      look.pitch += (lookGoal.pitch - look.pitch) * ease;
      if (Math.abs(lookGoal.yaw - look.yaw) + Math.abs(lookGoal.pitch - look.pitch) < 0.01) {
        look.yaw = lookGoal.yaw;
        look.pitch = lookGoal.pitch;
      }
      moving = true;
    }
    aim();
    return moving;
  }

  function layoutCanvas() {
    var w = window.innerWidth;
    var h = window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
    aim();
    wake(0.3);
  }

  // --- pointer -------------------------------------------------------------
  var raycaster = new Raycaster();
  var ndc = new Vector2();
  var pickable = [bank.faces, bank.cabinets, tube.mesh, deskCabinet].concat(room, controls.pickables);

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
  // The view being dragged round, and where the pointer last was.
  var looking = false;
  var lookFrom = { x: 0, y: 0 };
  function startLooking(ev) {
    looking = true;
    lookFrom.x = ev.clientX;
    lookFrom.y = ev.clientY;
    canvas.style.cursor = "grabbing";
    if (canvas.setPointerCapture) canvas.setPointerCapture(ev.pointerId);
  }
  function onUp(ev) {
    if (looking) {
      looking = false;
      canvas.style.cursor = "";
      if (canvas.hasPointerCapture && canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
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
    return controls.codeAt(hits[0]) || (hovering && controls.onDial(hits[0]) ? "dial" : null);
  }

  // The wheel over the dial turns it, a notch at a time; over the
  // terminal's screen it is the terminal's; over the wall it closes in on
  // the monitors there; anywhere else it does nothing.
  var lastNotch = 0;
  function onWheel(ev) {
    ev.preventDefault();
    if (!ev.deltaY || ev.timeStamp - lastNotch < 70) return;
    lastNotch = ev.timeStamp;
    // Closed in on the wall, the wheel backs off from anywhere; it closes
    // in only over the wall.
    if (zoomLevel && ev.deltaY > 0) return zoomAt(ev, -1);
    if (deskCellAt(ev)) {
      if (options.onDeskWheel) options.onDeskWheel(ev.deltaY > 0 ? 1 : -1);
      return;
    }
    if (deskLock) return;
    if (ev.deltaY < 0 && overWall(ev)) return zoomAt(ev, 1);
    var rect = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    var hits = raycaster.intersectObjects(pickable, false);
    if (hits.length && controls.onDial(hits[0]) && options.onControl) options.onControl(ev.deltaY > 0 ? "NumpadAdd" : "NumpadSubtract");
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
    if (looking) {
      // The scene is dragged, as a thing held: the head turns the other way.
      var perPixel = camera.fov / Math.max(window.innerHeight, 1);
      var dx = (ev.clientX - lookFrom.x) * perPixel;
      var dy = (ev.clientY - lookFrom.y) * perPixel;
      lookFrom.x = ev.clientX;
      lookFrom.y = ev.clientY;
      if (zoomLevel) {
        // Closed in on the wall, it is that view that moves.
        zoomGoal.yaw -= (dx * Math.PI) / 180;
        zoomGoal.pitch += dy;
        zoomView.yaw = zoomGoal.yaw;
        zoomView.pitch = zoomGoal.pitch;
      } else if (!deskLock) {
        lookTo(lookGoal.yaw - dx, lookGoal.pitch + dy);
      }
      return wake(1);
    }
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
  function onDown(ev) {
    // The right or middle button turns the view from anywhere; the left
    // does wherever it lands on nothing that takes a click.
    if (ev.button === 1 || ev.button === 2) {
      ev.preventDefault();
      return startLooking(ev);
    }
    if (ev.button !== 0) return;
    var over = monitorAt(ev);
    if (over && options.onPick) {
      // Picked: back from the close view of the wall.
      zoomLevel = 0;
      return options.onPick(over);
    }
    var code = controlAt(ev);
    if (code && options.onControl) return options.onControl(code);
    var cell = deskCellAt(ev);
    if (cell && options.onDeskPress && options.onDeskPress(cell)) {
      pressing = true;
      if (canvas.setPointerCapture) canvas.setPointerCapture(ev.pointerId);
      return;
    }
    if (!cell) startLooking(ev);
  }
  function onMenu(ev) {
    ev.preventDefault();
  }
  // Twice on nothing in particular: back to the seat's own view.
  function onDouble(ev) {
    if (monitorAt(ev) || controlAt(ev) || deskCellAt(ev)) return;
    zoomLevel = 0;
    lookTo(0, VIEW.seat.pitch);
    wake(1);
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
    // "seat", "keys", "left" or "right" turns the head to that view; "desk"
    // comes in close to the terminal and holds there; null lets that go.
    setView: function (view) {
      setDeskLock(view === "desk");
      if (view === "seat") lookTo(0, VIEW.seat.pitch);
      else if (view === "keys") lookTo(0, VIEW.keys.pitch);
      else if (view === "left" || view === "right") lookTo((view === "left" ? -1 : 1) * VIEW.side.yaw, VIEW.side.pitch);
      wake(1.5);
    },
    // "desk" while locked on the terminal; else the named view the head is
    // at, or "free" when it is somewhere of its own.
    view: function () {
      if (deskLock) return "desk";
      function at(yaw, pitch) {
        return Math.abs(lookGoal.yaw - yaw) < 0.5 && Math.abs(lookGoal.pitch - pitch) < 0.5;
      }
      if (at(0, VIEW.seat.pitch)) return "seat";
      if (at(0, VIEW.keys.pitch)) return "keys";
      if (at(VIEW.side.yaw, VIEW.side.pitch)) return "right";
      if (at(-VIEW.side.yaw, VIEW.side.pitch)) return "left";
      return "free";
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
