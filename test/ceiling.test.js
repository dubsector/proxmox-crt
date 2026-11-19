import { test } from "node:test";
import assert from "node:assert/strict";
import { ceilingLevel, createCeiling, roomLevel, CEILING_FULL, CEILING_DARK, CEILING_HOLD_S } from "../client/gl/ceiling.js";

test("the room starts dark and the tubes end fully on", function () {
  assert.equal(ceilingLevel(0, false), 0);
  assert.equal(ceilingLevel(CEILING_HOLD_S - 0.01, false), 0);
  assert.equal(ceilingLevel(CEILING_HOLD_S + 20, false), 1);
  assert.equal(ceilingLevel(CEILING_HOLD_S + 20, true), 1);
});

test("the tubes strike, drop out and strike again", function () {
  assert.ok(ceilingLevel(CEILING_HOLD_S + 0.03, false) > 0.4);
  assert.equal(ceilingLevel(CEILING_HOLD_S + 0.3, false), 0);
  assert.ok(ceilingLevel(CEILING_HOLD_S + 0.6, false) > 0.4);
});

test("reduced motion fades up without dropping out", function () {
  var last = 0;
  for (var t = 0; t < 4; t += 0.05) {
    var v = ceilingLevel(t, true);
    assert.ok(v >= last);
    last = v;
  }
});

test("the room pass runs from dark to the dimmed full level and then stops", function () {
  var c = createCeiling(false);
  var first = c.step(0);
  assert.equal(first.level, CEILING_DARK);
  assert.ok(first.changing);
  var r;
  for (var i = 0; i < 1000 && !c.done(); i++) r = c.step(1 / 60);
  assert.ok(c.done());
  assert.equal(r.level, CEILING_FULL);
  assert.equal(r.changing, false);
  assert.equal(roomLevel(1), CEILING_FULL);
  assert.ok(CEILING_FULL < 1);
});
