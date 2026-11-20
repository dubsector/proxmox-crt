import { test } from "node:test";
import assert from "node:assert/strict";
import { createDemoSource } from "../client/demo.js";

test("the demo cluster has the guests asked for, some of them stopped", function () {
  var snap = createDemoSource({ guests: 48, stopped: 3, seed: 5 }).snapshot();
  assert.equal(snap.guests.length, 48);
  assert.equal(snap.nodes.length, 3);
  assert.equal(snap.guests.filter(function (g) { return g.type === "qemu"; }).length, 2);
  assert.equal(new Set(snap.guests.map(function (g) { return g.vmid; })).size, 48);
  assert.ok(snap.guests.filter(function (g) { return g.status === "stopped"; }).length >= 3);
});

test("the same seed gives the same cluster", function () {
  function noon() {
    return 43200;
  }
  var a = createDemoSource({ seed: 9, clock: noon });
  var b = createDemoSource({ seed: 9, clock: noon });
  a.tick(2);
  b.tick(2);
  assert.deepEqual(a.snapshot(), b.snapshot());
});

test("readings stay in range as time passes", function () {
  var src = createDemoSource({ seed: 3 });
  var seen = 0;
  src.subscribe(function (snap) {
    seen++;
    snap.guests.forEach(function (g) {
      assert.ok(g.cpu >= 0 && g.cpu <= 1, "cpu " + g.cpu);
      assert.ok(g.mem >= 0 && g.mem <= g.maxmem);
      if (g.status !== "running") assert.equal(g.cpu, 0);
    });
    assert.ok(snap.nodes[0].cpu >= 0 && snap.nodes[0].cpu <= 1);
    assert.ok(snap.nodes[0].mem <= snap.nodes[0].maxmem);
  });
  for (var i = 0; i < 300; i++) src.tick(2);
  assert.equal(seen, 301);
});

test("counters only go up while a guest runs", function () {
  var src = createDemoSource({ seed: 4 });
  var before = src.snapshot().guests[0];
  src.tick(2);
  var after = src.snapshot().guests[0];
  assert.ok(after.netin >= before.netin);
  assert.ok(after.uptime >= before.uptime || after.status !== before.status);
});

test("setStatus stops and starts a guest and tells subscribers", function () {
  var src = createDemoSource({ seed: 4 });
  var last = null;
  src.subscribe(function (snap) { last = snap; });
  src.setStatus(100, "stopped");
  assert.equal(last.guests.find(function (g) { return g.vmid === 100; }).status, "stopped");
});

test("an empty cluster is still a cluster", function () {
  var snap = createDemoSource({ guests: 0 }).snapshot();
  assert.deepEqual(snap.guests, []);
  assert.equal(snap.nodes.length, 3);
});
