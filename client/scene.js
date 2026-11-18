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
// The cabinets under the wall: how many stand either side of the terminal,
// and how far from the middle the first begins (clear of the terminal as
// seen from the seat).
// The node monitors' strip above the keyboard: how big its sets are, how
// far in front of the terminal they sit, and how far they lie back.
var SIDE_SCALE = 0.34;
var SIDE_GAP = 0.14;
var SIDE_Z = 2.9;
var SIDE_LEAN = 1.0;
var MACHINES_A_SIDE = 2;
var MACHINES_FROM = 13.4;
// Each wall picture is half the desk terminal's raster each way, and holds
// 13 x 4 characters of the 9 x 14 ROM at three times its size: big enough
// to read from the seat.
var WALL_W = RASTER.width / 2;
var WALL_H = RASTER.height / 2;
var WALL_TEXT_SCALE = 3;

// Where the viewer's eye is, and the two ways of looking from it. Seated,
// the whole wall and the terminal's screen under it are in view at once, so
// nothing has to move to read one and pick from the other. Looking down
// brings the keyboard up into the frame.
var EYE = new Vector3(0, 2.8, 9);
var VIEW = {
  seat: { pitch: -6, fov: 44 },
  keys: { pitch: -21, fov: 44 },
};
var VIEW_EASE_S = 0.28;
// The pointer in the bottom of the window looks down at the keys; above
// the second line it looks back up. Between them the view stays where it is.
var LOOK_DOWN_BELOW = 0.88;
var LOOK_UP_ABOVE = 0.72;

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
// true to follow the drag), onDeskDrag({ col, row }), onDeskRelease() }
export function createScene(options) {
  var layout = wallLayout(options.guests);
  var wallCount = layout.columns * layout.rows;
  // A cabinet for each node, as far as there are cabinets.
  var nodeCount = Math.min(options.nodes || 0, MACHINES_A_SIDE * 2);
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
  var room = [
    // Back wall and floor.
    slab(260, 120, 1, 0, 30, WALL_Z - 6, plaster),
    slab(260, 1, 160, 0, -16, -20, floorMat),
    // The rack the monitors sit in, and the plinth under it.
    slab(wallW + 1.6, wallH + 1.6, 3.6, 0, wallMidY - 0.05, WALL_Z - 2.4, steel),
    slab(wallW + 1.6, WALL_BOTTOM_Y + 16 - PITCH_Y / 2 - 0.8, 3.0, 0, (WALL_BOTTOM_Y - PITCH_Y / 2 - 0.8 - 16) / 2, WALL_Z - 2.7, steel),
    // The desk, and the terminal's keyboard on it.
    slab(34, 0.7, 13, 0, DESK_Y - 0.35, 0.5, wood),
    slab(7.6, 0.4, 2.9, 0, DESK_Y + 0.2, 4.6, cream),
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
  var machines = createMachines({ slots: slots, still: reduced });
  scene.add(machines.group);

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
  var lookDown = 0;
  var lookDownGoal = 0;
  var viewLock = null; // "seat" | "keys" | null: follow the pointer
  var parallax = new Vector2(0, 0);
  var parallaxGoal = new Vector2(0, 0);
  var target = new Vector3();

  function fovFor(view, aspect) {
    // In a narrow window the lens widens until the wall (or the terminal)
    // still fits across it.
    var halfWidth = view === VIEW.seat ? (wallW / 2 + 1.2) / (EYE.z - WALL_Z) : 4.4 / EYE.z;
    var need = (2 * Math.atan(halfWidth / aspect) * 180) / Math.PI;
    return Math.max(view.fov, Math.min(need, 100));
  }

  function aim() {
    var k = lookDown * lookDown * (3 - 2 * lookDown);
    var aspect = camera.aspect;
    var pitch = VIEW.seat.pitch + (VIEW.keys.pitch - VIEW.seat.pitch) * k;
    var fov = fovFor(VIEW.seat, aspect) + (fovFor(VIEW.keys, aspect) - fovFor(VIEW.seat, aspect)) * k;
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    // The head drifts a little with the pointer.
    camera.position.set(EYE.x + parallax.x * 0.35, EYE.y + parallax.y * 0.15, EYE.z);
    var r = (pitch * Math.PI) / 180;
    target.set(parallax.x * 0.1, EYE.y + Math.sin(r) * 10, EYE.z - Math.cos(r) * 10);
    camera.lookAt(target);
  }

  function stepView(dt) {
    var moving = false;
    var goal = viewLock === "keys" ? 1 : viewLock === "seat" ? 0 : lookDownGoal;
    if (lookDown !== goal) {
      if (reduced) lookDown = goal;
      else {
        lookDown += (goal - lookDown) * (1 - Math.exp(-dt / VIEW_EASE_S));
        if (Math.abs(goal - lookDown) < 0.002) lookDown = goal;
      }
      moving = true;
    }
    if (!reduced && parallax.distanceToSquared(parallaxGoal) > 1e-6) {
      parallax.lerp(parallaxGoal, 1 - Math.exp(-dt / 0.35));
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
  var pickable = [bank.faces, bank.cabinets, tube.mesh, deskCabinet].concat(room);

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
  function onUp(ev) {
    if (!pressing) return;
    pressing = false;
    if (canvas.hasPointerCapture && canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
    if (options.onDeskRelease) options.onDeskRelease();
  }

  var hovered = 0;
  function onMove(ev) {
    if (pressing) {
      var cell = deskCellAt(ev);
      if (cell && options.onDeskDrag) options.onDeskDrag(cell);
      wake(1);
      return;
    }
    var fy = ev.clientY / Math.max(window.innerHeight, 1);
    var fx = ev.clientX / Math.max(window.innerWidth, 1);
    if (fy > LOOK_DOWN_BELOW) lookDownGoal = 1;
    else if (fy < LOOK_UP_ABOVE) lookDownGoal = 0;
    parallaxGoal.set(fx * 2 - 1, 1 - fy * 2);
    var over = monitorAt(ev);
    if (over !== hovered) {
      hovered = over;
      canvas.style.cursor = over ? "pointer" : "";
      if (options.onHover) options.onHover(over);
    }
    wake(1);
  }
  function onDown(ev) {
    if (ev.button !== 0) return;
    var over = monitorAt(ev);
    if (over && options.onPick) return options.onPick(over);
    var cell = deskCellAt(ev);
    if (cell && options.onDeskPress && options.onDeskPress(cell)) {
      pressing = true;
      if (canvas.setPointerCapture) canvas.setPointerCapture(ev.pointerId);
    }
  }
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
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
    // which one cabinet's lamps and tape reels follow.
    setNodeLoad: function (number, load) {
      machines.setLoad(number - 1, load);
    },
    deskCellAt: deskCellAt,
    setSelected: setSelected,
    // "seat" or "keys" holds that view; null goes back to following the pointer.
    setView: function (view) {
      viewLock = view;
      wake(1.5);
    },
    view: function () {
      return viewLock || (lookDownGoal ? "keys" : "seat");
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
      window.removeEventListener("resize", layoutCanvas);
      tube.dispose();
      bank.dispose();
      machines.dispose();
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
