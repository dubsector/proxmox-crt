import { test } from "node:test";
import assert from "node:assert/strict";
import { createTelemetry, activity, ago, SIGNS, RACKS, DARK, GREEN, AMBER, RED } from "../client/telemetry.js";
import { clockDigits } from "../client/gl/panels.js";
import { createDemoSource } from "../client/demo.js";

var GIB = 1024 * 1024 * 1024;

function sign(room, word) {
  return room.signs.find(function (s) {
    return s.word === word;
  }).state;
}

// A small cluster: one node, two guests, written out so each reading can
// be traced to what it came from.
function cluster(t) {
  return {
    t: t,
    nodes: [{ node: "pve", status: "online", cpu: 0.25, maxcpu: 8, mem: 8 * GIB, maxmem: 32 * GIB, disk: 10 * GIB, maxdisk: 100 * GIB, uptime: 90061, loadavg: [2, 1, 0.5], wait: 0.05, swap: 0, maxswap: 8 * GIB, version: "9.0.3" }],
    guests: [
      { vmid: 101, name: "web", type: "lxc", node: "pve", status: "running", cpu: 0.9, maxcpu: 2, mem: 0.5 * GIB, maxmem: GIB, disk: GIB, maxdisk: 8 * GIB, netin: 1e6 * t, netout: 0, diskread: 0, diskwrite: 2e6 * t, uptime: 500 },
      { vmid: 100, name: "db", type: "lxc", node: "pve", status: "stopped", cpu: 0, maxcpu: 2, mem: 0, maxmem: GIB, disk: 0, maxdisk: 8 * GIB, netin: 0, netout: 0, diskread: 0, diskwrite: 0, uptime: 0 },
    ],
    storage: [
      { storage: "local", node: "pve", shared: false, status: "available", disk: 95, maxdisk: 100 },
      { storage: "tank", node: "pve", shared: false, status: "available", disk: 50, maxdisk: 100 },
    ],
    tasks: [
      { type: "vzstart", id: "101", node: "pve", start: t - 5, end: null, status: null },
      { type: "vzdump", id: "", node: "pve", start: t - 4000, end: t - 3600, status: "OK" },
      { type: "qmstart", id: "900", node: "pve", start: t - 7300, end: t - 7200, status: "no such VM" },
    ],
    cluster: { name: null, quorate: null },
    time: 43200 + (t - 1000),
  };
}

test("each rack shows something of the cluster, and nothing it was not told", function () {
  var telemetry = createTelemetry({ lamps: 70, lampCols: 5, machines: 16, history: 96 });
  telemetry.read(cluster(1000));
  var room = telemetry.read(cluster(1010));
  assert.equal(room.racks.length, RACKS);

  // Beside the monitors: guests in the wall's order (stopped red, busy amber).
  assert.deepEqual(Array.from(room.racks[0].lamps.slice(0, 3)), [RED, AMBER, DARK]);
  assert.equal(room.racks[0].label, "PVE TIME");
  assert.deepEqual(room.racks[0].clock, { seconds: 43210, ticking: true, form: "day" });
  assert.deepEqual(room.racks[0].meters, [0.25, null, null]);
  assert.deepEqual(Array.from(room.racks[1].lamps.slice(0, 2)), [DARK, GREEN]);
  assert.equal(room.racks[1].clock.seconds, 3600);
  assert.deepEqual(room.racks[1].meters, [0.25, null, null]);
  // Storage: five lamps to each, lit as far as it is full.
  assert.deepEqual(Array.from(room.racks[2].lamps.slice(0, 10)), [RED, RED, RED, RED, RED, GREEN, GREEN, GREEN, DARK, DARK]);
  // Tasks, newest first.
  assert.deepEqual(Array.from(room.racks[3].lamps.slice(0, 4)), [AMBER, GREEN, RED, DARK]);
  assert.equal(room.racks[3].meters[0], 0.2);
  // The node's own rack, then guests' where the nodes run out.
  assert.equal(room.racks[4].label, "PVE UP D:H:M");
  assert.deepEqual(room.racks[4].clock, { seconds: 90061, ticking: true, form: "dhm" });
  assert.deepEqual(room.racks[4].meters, [0.25, 0.125, 0.0625]);
  assert.equal(room.racks[5].label, "WEB UP D:H:M");
  assert.equal(room.racks[5].clock.seconds, 500);
  // The scopes hold as many readings as asked for.
  assert.equal(room.racks[0].scope.length, 96);
  assert.ok(room.racks[1].scope[95] > 0.9);
});

test("the cabinets follow the node, its disks, its network and the busiest guests", function () {
  var telemetry = createTelemetry({ machines: 6 });
  telemetry.read(cluster(1000));
  var room = telemetry.read(cluster(1010));
  assert.equal(room.machines.length, 6);
  assert.equal(room.machines[0], 0.25);
  assert.equal(room.machines[1], activity(2e6));
  assert.equal(room.machines[2], activity(1e6));
  assert.equal(room.machines[3], 0.9);
  assert.equal(room.machines[4], null);
});

test("the signs say how the cluster stands", function () {
  var telemetry = createTelemetry();
  var first = telemetry.read(cluster(1000));
  assert.deepEqual(
    first.signs.map(function (s) {
      return s.word;
    }),
    SIGNS,
  );
  // No rate is known from one reading alone.
  assert.equal(sign(first, "NETWORK"), "off");
  var room = telemetry.read(cluster(1010));
  assert.equal(sign(room, "QUORUM"), "ok");
  assert.equal(sign(room, "NODES"), "ok");
  assert.equal(sign(room, "NETWORK"), "ok");
  assert.equal(sign(room, "DISK IO"), "ok");
  assert.equal(sign(room, "STORAGE"), "fault");
  assert.equal(sign(room, "BACKUP"), "ok");
  assert.equal(sign(room, "SWAP"), "off");
  assert.equal(sign(room, "TASKS"), "ok");
  assert.equal(sign(room, "MIGRATE"), "off");
  assert.equal(sign(room, "ALARM"), "fault");

  var bad = cluster(1020);
  bad.cluster = { name: "lab", quorate: false };
  bad.nodes[0].status = "offline";
  bad.tasks = [{ type: "vzdump", id: "", node: "pve", start: 900, end: 1000, status: "job errors" }];
  var after = telemetry.read(bad);
  assert.equal(sign(after, "QUORUM"), "fault");
  assert.equal(sign(after, "NODES"), "fault");
  assert.equal(sign(after, "BACKUP"), "fault");
  assert.equal(sign(after, "TASKS"), "fault");
  assert.equal(sign(after, "CPU"), "off");
  assert.equal(after.machines[0], -1);
  assert.equal(after.racks[4].clock.seconds, null);
});

test("what the token may not see is shown as not known", function () {
  var bare = cluster(1000);
  bare.storage = [];
  bare.tasks = null;
  bare.cluster = null;
  bare.time = null;
  assert.equal(createTelemetry().read(bare).racks[0].clock.seconds, null);
  bare.nodes[0].loadavg = null;
  bare.nodes[0].wait = null;
  var room = createTelemetry().read(bare);
  assert.equal(room.racks[1].clock.seconds, null);
  assert.equal(room.board.tasks, null);
  assert.deepEqual(room.board.storage, []);
  assert.equal(sign(room, "STORAGE"), "off");
  assert.equal(sign(room, "BACKUP"), "off");
  assert.equal(sign(room, "IO WAIT"), "off");
  assert.equal(sign(room, "LOAD"), "off");
  assert.equal(sign(room, "ALARM"), "off");
  assert.deepEqual(room.racks[4].meters, [null, null, null]);
  assert.ok(
    Array.from(room.racks[3].lamps).every(function (l) {
      return l === DARK;
    }),
  );
});

test("the status board lists storage fullest first and tasks newest first", function () {
  var room = createTelemetry().read(cluster(1000));
  assert.equal(room.board.cluster, "PVE");
  assert.deepEqual(room.board.summary, ["NODES 1/1", "GUESTS 1/2", "PVE 9.0.3"]);
  assert.deepEqual(room.board.storage, [
    { name: "local", node: "pve", used: 0.95, state: "fault" },
    { name: "tank", node: "pve", used: 0.5, state: "ok" },
  ]);
  assert.deepEqual(room.board.tasks[0], { ago: "5s", node: "pve", what: "vzstart 101", state: "run" });
  assert.deepEqual(room.board.tasks[1], { ago: "1h", node: "pve", what: "vzdump", state: "ok" });
  assert.equal(room.board.tasks[2].state, "fault");
});

test("the demo cluster gives every rack, cabinet and sign something to show", function () {
  var src = createDemoSource({ seed: 7 });
  var telemetry = createTelemetry({ machines: 16 });
  var room = null;
  src.subscribe(function (snap) {
    room = telemetry.read(snap);
  });
  for (var i = 0; i < 30; i++) src.tick(2);
  room.racks.forEach(function (rack, i) {
    assert.ok(rack.label, "rack " + i + " has a label");
    assert.ok(rack.clock.kind || typeof rack.clock.seconds === "number", "rack " + i + " has a clock");
    assert.ok(rack.lamps.some(Boolean), "rack " + i + " has lamps lit");
    assert.ok(rack.meters.every(function (m) { return typeof m === "number"; }), "rack " + i + " has meters");
  });
  assert.ok(room.machines.every(function (m) { return typeof m === "number"; }));
  assert.equal(room.board.storage.length, 7);
  assert.ok(room.board.tasks.length >= 4);
  assert.equal(room.board.cluster, "DEMO");
  assert.equal(sign(room, "QUORUM"), "ok");
  assert.equal(sign(room, "NETWORK"), "ok");
});

test("small things are said in few characters", function () {
  assert.equal(activity(0), 0);
  assert.equal(activity(1e8), 1);
  assert.ok(activity(1e6) > activity(1e4));
  assert.equal(ago(59), "59s");
  assert.equal(ago(3600 * 7 + 5), "7h");
  assert.equal(ago(86400 * 3), "3d");
  assert.equal(clockDigits(3661, "hms"), "010101");
  assert.equal(clockDigits(90061, "dhm"), "010101");
  assert.equal(clockDigits(86400 * 200, "dhm"), "992359");
  assert.equal(clockDigits(86400 + 3661, "day"), "010101");
});
