// Where everything in the office stands, in tube units (about 61 mm) with
// the desk terminal's tube face at the origin, facing +Z, and +Y up.
//
// Nothing here draws. scene.js places the live parts from it, and
// tools/office-layout.mjs writes it out for the Blender scripts that model
// and bake the room (tools/blender/), so the baked shell and the live parts
// in front of it cannot drift apart.
import { CABINET } from "./gl/bank.js";
import { KEYPAD, KEY_PITCH, KEY_SIZE } from "./gl/controls.js";
import { MACHINE } from "./gl/machines.js";
import { PANEL } from "./gl/panels.js";

// The wall's shape: one size, 13 x 4, whatever the host. The room around it
// is baked, and light maps belong to one shape of room; with fewer guests the
// sets nobody needs stay switched off.
export var WALL = { columns: 13, rows: 4 };

// Wall monitors are 9-inch sets, three quarters the size of the terminal's
// 12-inch tube, in a rack with a little steel showing between them.
export var WALL_SCALE = 0.75;
export var PITCH_X = 3.9;
export var PITCH_Y = 3.3;
export var WALL_Z = -36;
// Centre of the bottom row: as low as it can be with the whole row still
// showing over the top of the terminal from the seat.
export var WALL_BOTTOM_Y = 2.4;
// The desk top. The terminal is the one from dubsector/terminal, whose tube
// centre stands 166.97 mm above its desk.
export var DESK_Y = -2.739;
// The desk's extent: x either way, and z from its back edge to its front.
export var DESK = { halfW: 17, back: -7.6, front: 7.2 };
// The floor.
export var FLOOR_Y = -16;
// The node monitors' console above the keyboard: how big its sets are, how
// far in front of the terminal they sit, how far they lie back, and how far
// above the desk the lowest edge of a set is.
export var SIDE_SCALE = 0.34;
export var SIDE_GAP = 0.08;
export var SIDE_Z = 3.0;
export var SIDE_LEAN = 1.0;
export var SIDE_LIFT = 0.17;
// The console always holds this many sets, in a bay of its face plate; with
// fewer nodes the spare ones stay dark, as the wall's do. A fourth node
// makes all of them smaller (see nodeSetScale).
export var NODE_SETS = 3;
export var NODE_BAY_MARGIN = 0.04;
// Half the width of the console.
export var NODE_PLINTH_HALF_W = 2.98;
// The cabinets under the wall: how many stand either side of the middle.
// They run right across, behind the terminal too, so the wall is not bare
// wherever the terminal is seen from.
export var MACHINES_A_SIDE = 4;
// Beyond the monitors and the rack beside them, each way: a big board with
// this many more cabinets under it, a last rack in the corner, and then the
// side wall, with this many racks along it.
export var BOARD_MACHINES = 4;
export var SIDE_RACKS = 2;

export function officeLayout() {
  var columns = WALL.columns;
  var rows = WALL.rows;
  var wallW = columns * PITCH_X;
  var wallH = rows * PITCH_Y;
  var wallMidY = WALL_BOTTOM_Y + ((rows - 1) * PITCH_Y) / 2;
  // Where the gear beyond the monitors starts and ends, out from the middle.
  var rackX = wallW / 2 + 0.8 + 0.3 + PANEL.width / 2;
  var rackTop = wallMidY + wallH / 2 + 0.75;
  var boardFrom = rackX + PANEL.width / 2 + 0.3;
  var boardW = BOARD_MACHINES * MACHINE.width;
  var cornerX = boardFrom + boardW + 0.3 + PANEL.width / 2;
  var sideWallX = cornerX + PANEL.width / 2 + 0.3;
  var machineTop = WALL_BOTTOM_Y - PITCH_Y / 2 - 1.0;

  // Monitor 1 is top left; numbers run along each row, as they are read.
  var monitors = [];
  for (var i = 0; i < columns * rows; i++) {
    var col = i % columns;
    var row = Math.floor(i / columns);
    monitors.push({ x: (col - (columns - 1) / 2) * PITCH_X, y: WALL_BOTTOM_Y + (rows - 1 - row) * PITCH_Y, z: WALL_Z });
  }

  // Under the wall, either side of the terminal, the computer room; then
  // more cabinets under the boards, which idle.
  var machines = [];
  [-1, 1].forEach(function (side) {
    for (var k = 0; k < MACHINES_A_SIDE; k++) {
      var out = side < 0 ? MACHINES_A_SIDE - 1 - k : k;
      machines.push({ x: side * (MACHINE.width / 2 + out * MACHINE.width), top: machineTop, z: WALL_Z + 0.2 });
    }
  });
  [-1, 1].forEach(function (side) {
    for (var k = 0; k < BOARD_MACHINES; k++) {
      machines.push({ x: side * (boardFrom + MACHINE.width / 2 + k * MACHINE.width), top: machineTop, z: WALL_Z + 0.2 });
    }
  });

  var racks = [
    { x: -rackX, top: rackTop, z: WALL_Z + 0.2 },
    { x: rackX, top: rackTop, z: WALL_Z + 0.2 },
    { x: -cornerX, top: rackTop, z: WALL_Z + 0.2 },
    { x: cornerX, top: rackTop, z: WALL_Z + 0.2 },
  ];
  // The side walls' racks, facing in. Each side's racks are laid out in a
  // frame of their own (x along the wall), which stands at `x` turned by
  // `turn` about Y.
  var sideRacks = [-1, 1].map(function (side) {
    var along = [];
    for (var k = 0; k < SIDE_RACKS; k++) {
      along.push({ x: side * (WALL_Z + 0.6 + PANEL.width / 2 + k * (PANEL.width + 0.3)), top: rackTop, z: 0 });
    }
    return { x: side * (sideWallX - 0.2), turn: (-side * Math.PI) / 2, racks: along };
  });

  var boardH = rackTop - machineTop - 0.3;

  return {
    columns: columns,
    rows: rows,
    wallScale: WALL_SCALE,
    pitch: [PITCH_X, PITCH_Y],
    wallZ: WALL_Z,
    wallW: wallW,
    wallH: wallH,
    wallMidY: wallMidY,
    deskY: DESK_Y,
    desk: DESK,
    floorY: FLOOR_Y,
    cabinet: CABINET,
    machine: MACHINE,
    panel: PANEL,
    rackX: rackX,
    rackTop: rackTop,
    boardFrom: boardFrom,
    boardW: boardW,
    cornerX: cornerX,
    sideWallX: sideWallX,
    machineTop: machineTop,
    monitors: monitors,
    // The rack the monitors sit in, and the plinth under it.
    monitorRack: { x: 0, y: wallMidY - 0.05, z: WALL_Z - 2.4, w: wallW + 1.6, h: wallH + 1.6, d: 3.6 },
    plinth: { x: 0, top: WALL_BOTTOM_Y - PITCH_Y / 2 - 0.8, z: WALL_Z - 2.7, w: wallW + 1.6, d: 3.0 },
    backWallZ: WALL_Z - 6,
    machines: machines,
    racks: racks,
    sideRacks: sideRacks,
    boards: {
      track: { x: -(boardFrom + boardW / 2), y: rackTop - boardH / 2, z: WALL_Z + 0.2, width: boardW - 0.4, height: boardH },
      trend: { x: boardFrom + boardW / 2, y: rackTop - boardH / 2, z: WALL_Z + 0.2, width: boardW - 0.4, height: boardH },
    },
    signs: { y: rackTop + 1.35, z: WALL_Z + 0.2, width: (sideWallX + PANEL.depth) * 2, height: 2 },
    // Node monitors: a strip of small sets in a sloped panel between the
    // terminal and its keyboard.
    nodeStrip: {
      scale: SIDE_SCALE,
      gap: SIDE_GAP,
      z: SIDE_Z,
      lean: SIDE_LEAN,
      lift: SIDE_LIFT,
      setW: CABINET.halfW * 2 * SIDE_SCALE,
      halfW: NODE_PLINTH_HALF_W,
      bayHalfW: nodeBayHalfW(),
      bayMargin: NODE_BAY_MARGIN,
      // Where the console's own sets are: the model has these.
      sets: nodeSetPlaces(NODE_SETS),
    },
    // The switcher: its box beside the terminal, where the seat can read it,
    // and the keypad and dial, in one case on the desk to the right of the
    // node monitors.
    controls: {
      box: { x: 5.2, z: -2.4, turn: -0.3 },
      keypad: { x: 4.75, z: 2.0, pitch: KEY_PITCH, size: KEY_SIZE, keys: KEYPAD },
      dial: { x: 7.2, z: 2.0 },
    },
    lavaLamp: { x: -5.4, z: -2.2 },
    props: {
      logbook: { x: -7.2, z: 3.4, turn: 0.22 },
      mug: { x: -9.6, z: 1.2 },
      lamp: { x: 14.6, z: -1.6, turn: 3.75 },
    },
    // Each lamp's cord: from its base to the switch lying on the desk, and
    // on to where it drops over the desk's back edge.
    cords: {
      lava: {
        x: -4.6,
        z: -0.6,
        turn: 0.35,
        fromLamp: [[-5.25, -1.62]],
        toWall: [
          [-3.95, 0.25],
          [-3.35, -0.7],
          [-3.45, -3.4],
          [-3.7, -7.6],
        ],
      },
      // The desk lamp's leaves its base on the left and goes back to the
      // desk's edge, with the switch part of the way along it.
      lamp: {
        x: 11.45,
        z: -2.9,
        turn: -2.61,
        fromLamp: [
          [13.25, -1.6],
          [12.55, -1.75],
        ],
        toWall: [
          [10.85, -4.6],
          [11.0, -7.6],
        ],
      },
    },
    // The terminal's keyboard: the middle of its front edge.
    keyboard: { x: 0, z: 6.29, turn: 0 },
  };
}

// Half the width of the bay the node monitors sit in.
function nodeBayHalfW() {
  return (NODE_SETS * (CABINET.halfW * 2 * SIDE_SCALE + SIDE_GAP) - SIDE_GAP) / 2 + NODE_BAY_MARGIN;
}

// How big each node monitor is for this many nodes: SIDE_SCALE for the
// console's own number of sets, smaller when there are more.
export function nodeSetScale(count) {
  var fit = (2 * (nodeBayHalfW() - NODE_BAY_MARGIN) + SIDE_GAP) / Math.max(count, NODE_SETS) - SIDE_GAP;
  return Math.min(SIDE_SCALE, fit / (CABINET.halfW * 2));
}

// Where each of `count` node monitors' tube faces is, left to right, and
// how big: [{ x, y, z, scale }]. Smaller sets stay in the middle of the
// bay's height.
export function nodeSetPlaces(count) {
  var scale = nodeSetScale(count);
  var setW = CABINET.halfW * 2 * scale;
  var rowW = count * (setW + SIDE_GAP) - SIDE_GAP;
  // Up the slope, in the page's y and z.
  var up = [Math.cos(SIDE_LEAN), -Math.sin(SIDE_LEAN)];
  // The face's centre is this far up the slope from the set's lowest edge
  // at full size; a smaller set keeps the middle of its case where a full
  // one has it.
  var middle = (CABINET.top + CABINET.bottom) / 2;
  var rise = -CABINET.bottom * SIDE_SCALE + middle * (SIDE_SCALE - scale);
  var places = [];
  for (var n = 0; n < count; n++) {
    places.push({ x: -rowW / 2 + setW / 2 + n * (setW + SIDE_GAP), y: DESK_Y + SIDE_LIFT + rise * up[0], z: SIDE_Z + rise * up[1], scale: scale });
  }
  return places;
}

// Which of the console's sets node `n` of `count` (from 0) shows on: left
// to right, but a lone node takes the middle one.
export function nodeSetFor(n, count) {
  return count === 1 ? Math.floor(NODE_SETS / 2) : n;
}
