import { test } from "node:test";
import assert from "node:assert/strict";
import { officeLayout, nodeSetPlaces, nodeSetFor, nodeSetScale, NODE_SETS, SIDE_SCALE, SIDE_GAP } from "../client/layout.js";
import { CABINET } from "../client/gl/bank.js";
import { KEYPAD } from "../client/gl/controls.js";

test("the console's own sets are full size and fill its bay", function () {
  var strip = officeLayout().nodeStrip;
  assert.equal(strip.sets.length, NODE_SETS);
  assert.equal(nodeSetScale(1), SIDE_SCALE);
  assert.equal(nodeSetScale(NODE_SETS), SIDE_SCALE);
  var half = (CABINET.halfW * 2 * SIDE_SCALE) / 2;
  assert.ok(Math.abs(strip.sets[NODE_SETS - 1].x + half + strip.bayMargin - strip.bayHalfW) < 1e-9);
  assert.ok(strip.bayHalfW < strip.halfW);
});

test("a fourth node makes the sets smaller, and they still fit the bay without touching", function () {
  var strip = officeLayout().nodeStrip;
  var places = nodeSetPlaces(4);
  assert.equal(places.length, 4);
  var setW = CABINET.halfW * 2 * places[0].scale;
  assert.ok(places[0].scale < SIDE_SCALE);
  assert.ok(places[3].x + setW / 2 <= strip.bayHalfW - strip.bayMargin + 1e-9);
  for (var i = 1; i < 4; i++) assert.ok(Math.abs(places[i].x - places[i - 1].x - setW - SIDE_GAP) < 1e-9);
  // Smaller sets stay in the middle of the bay's height: the middle of a
  // case is where a full-size one has it.
  var middle = (CABINET.top + CABINET.bottom) / 2;
  var up = Math.cos(strip.lean);
  assert.ok(Math.abs(places[0].y + middle * places[0].scale * up - (strip.sets[0].y + middle * SIDE_SCALE * up)) < 1e-9);
});

test("nodes take the console's sets left to right, a lone node the middle one", function () {
  assert.equal(nodeSetFor(0, 1), 1);
  assert.deepEqual([nodeSetFor(0, 2), nodeSetFor(1, 2)], [0, 1]);
  assert.deepEqual([0, 1, 2, 3].map(function (n) { return nodeSetFor(n, 4); }), [0, 1, 2, 3]);
});

test("the keypad's keys cover its four by four cells once each", function () {
  var cells = {};
  KEYPAD.forEach(function (k) {
    for (var c = k.col; c < k.col + k.w; c++) {
      for (var r = k.row; r < k.row + k.h; r++) {
        assert.ok(c < 4 && r < 4, k.code);
        assert.equal(cells[c + "," + r], undefined, k.code);
        cells[c + "," + r] = k.code;
      }
    }
    assert.ok(k.legend);
  });
  assert.equal(Object.keys(cells).length, 16);
  assert.equal(new Set(KEYPAD.map(function (k) { return k.code; })).size, KEYPAD.length);
});
