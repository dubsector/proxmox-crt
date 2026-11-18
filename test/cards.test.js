import { test } from "node:test";
import assert from "node:assert/strict";
import { createGrid, paintGrid, GAUGE_ON, GAUGE_OFF } from "../client/gl/textgrid.js";
import { wallCard, nodeCard, deskCard, uptime, WALL_COLS, WALL_ROWS, DESK_COLS, DESK_ROWS } from "../client/cards.js";
import { createDemoSource } from "../client/demo.js";

var GIB = 1024 * 1024 * 1024;
var guest = {
  vmid: 107,
  name: "nginx-proxy",
  type: "lxc",
  node: "pve",
  status: "running",
  cpu: 0.5,
  maxcpu: 2,
  mem: GIB,
  maxmem: 4 * GIB,
  disk: 2 * GIB,
  maxdisk: 8 * GIB,
  netin: 0,
  netout: 0,
  uptime: 90061,
  tags: "",
};

test("a running guest's wall card", function () {
  var lines = wallCard(createGrid(WALL_COLS, WALL_ROWS), guest, 7).lines();
  assert.equal(lines[0], "07 CT 107    ");
  assert.equal(lines[1], "nginx-proxy  ");
  assert.equal(lines[2], "C " + GAUGE_ON.repeat(4) + GAUGE_OFF.repeat(3) + " 50%");
  assert.equal(lines[3], "M " + GAUGE_ON.repeat(2) + GAUGE_OFF.repeat(5) + " 25%");
});

test("a stopped guest's wall card says OFFLINE", function () {
  var lines = wallCard(createGrid(WALL_COLS, WALL_ROWS), Object.assign({}, guest, { status: "stopped", type: "qemu" }), 48).lines();
  assert.equal(lines[0], "48 VM 107    ");
  assert.match(lines[2], /^ +OFFLINE +$/);
  assert.equal(lines[3].trim(), "PWR TO START");
});

test("names too long for a wall monitor are cut, with a mark", function () {
  var lines = wallCard(createGrid(WALL_COLS, WALL_ROWS), Object.assign({}, guest, { name: "a-very-long-container-name" }), 1).lines();
  assert.equal(lines[1], "a-very-long-~");
});

test("an idle but running guest still shows one segment", function () {
  var lines = wallCard(createGrid(WALL_COLS, WALL_ROWS), Object.assign({}, guest, { cpu: 0.004 }), 1).lines();
  assert.equal(lines[2], "C " + GAUGE_ON + GAUGE_OFF.repeat(6) + "  0%");
});

test("the node card counts its own guests", function () {
  var node = { node: "pve", status: "online", cpu: 0.25, maxcpu: 8, mem: 8 * GIB, maxmem: 16 * GIB, loadavg: [1, 1, 1] };
  var others = [guest, Object.assign({}, guest, { status: "stopped" }), Object.assign({}, guest, { node: "pve2" })];
  var lines = nodeCard(createGrid(WALL_COLS, WALL_ROWS), node, others).lines();
  assert.equal(lines[0].trim(), "NODE pve");
  assert.equal(lines[1].trim(), "1/2 up");
});

test("the desk card fits the screen for every guest of the demo", function () {
  var snap = createDemoSource({ seed: 1 }).snapshot();
  var grid = createGrid(DESK_COLS, DESK_ROWS);
  snap.guests.forEach(function (g, i) {
    var lines = deskCard(grid, { node: snap.nodes[0], guest: g, number: i + 1, total: snap.guests.length, extra: { history: [0.1, 0.9], netin: 1e6, netout: 10 } }).lines();
    assert.equal(lines.length, DESK_ROWS);
    assert.match(lines[3], new RegExp(g.name.slice(0, 20).replace(/[-]/g, "\\-")));
  });
  assert.match(deskCard(grid, { node: snap.nodes[0], guest: null, total: 48 }).lines()[3], /NO MONITOR SELECTED/);
});

test("uptime is short on the wall and long on the desk", function () {
  assert.equal(uptime(90061), "1d 01h");
  assert.equal(uptime(3700), "1h 01m");
  assert.equal(uptime(59), "0m 59s");
  assert.equal(uptime(90061, true), "1d 01h 01m");
});

test("painting lights dots only inside the raster and reports the picture level", function () {
  var grid = createGrid(WALL_COLS, WALL_ROWS);
  var out = new Uint8Array(360 * 175);
  assert.equal(paintGrid(grid, out, 360, 175, 3), 0);
  wallCard(grid, guest, 7);
  var level = paintGrid(grid, out, 360, 175, 3);
  assert.ok(level > 0.02 && level < 0.6, "level " + level);
  var lit = out.reduce(function (n, v) { return n + (v ? 1 : 0); }, 0);
  assert.ok(lit > 500);
  // An all-inverse grid is the brightest a screen can be.
  for (var y = 0; y < WALL_ROWS; y++) grid.paint(0, y, WALL_COLS, 4);
  assert.ok(paintGrid(grid.clear(), out, 360, 175, 3) === 0);
});
