import { test } from "node:test";
import assert from "node:assert/strict";
import { createWax, stepWax, pooled, liquidWarmth } from "../client/gl/lavawax.js";

var floorOf = function (b) {
  return 0.03 + b.size * 0.25;
};
var ceilingOf = function (b) {
  return 1 - b.size * 0.5 - 0.02;
};

test("the liquid is warm at the bottom and cool at the top", function () {
  assert.ok(liquidWarmth(0, 1) > liquidWarmth(1, 1));
  assert.equal(liquidWarmth(0.5, 0), 0);
});

test("hot wax keeps going up and down, all the way", function () {
  var wax = createWax(7, 11);
  stepWax(wax, 120, 1, floorOf, ceilingOf);
  var top = wax.blobs.map(function () {
    return 0;
  });
  var bottom = wax.blobs.map(function () {
    return 1;
  });
  for (var t = 0; t < 600; t++) {
    stepWax(wax, 0.5, 1, floorOf, ceilingOf);
    wax.blobs.forEach(function (b, i) {
      top[i] = Math.max(top[i], b.h);
      bottom[i] = Math.min(bottom[i], b.h);
    });
  }
  // Most blobs make the whole trip, from the pool to high in the glass.
  var travelled = top.filter(function (h, i) {
    return h > 0.7 && bottom[i] < 0.15;
  }).length;
  assert.ok(travelled >= 4, "only " + travelled + " blobs made the trip");
  assert.equal(pooled(wax) < 0.05, true);
});

test("cold, the wax settles into the pool, and rises again once warm", function () {
  var wax = createWax(7, 11);
  stepWax(wax, 120, 1, floorOf, ceilingOf);
  stepWax(wax, 300, 0, floorOf, ceilingOf);
  assert.ok(pooled(wax) > 0.98);
  wax.blobs.forEach(function (b) {
    assert.ok(b.h <= floorOf(b) + 1e-9);
  });
  stepWax(wax, 120, 1, floorOf, ceilingOf);
  assert.ok(pooled(wax) < 0.5);
  assert.ok(
    wax.blobs.some(function (b) {
      return b.h > 0.5;
    }),
  );
});

test("a long frame moves the wax as many short ones do", function () {
  var a = createWax(5, 3);
  var b = createWax(5, 3);
  stepWax(a, 2, 1, floorOf, ceilingOf);
  for (var i = 0; i < 40; i++) stepWax(b, 0.05, 1, floorOf, ceilingOf);
  a.blobs.forEach(function (blob, i) {
    assert.ok(Math.abs(blob.h - b.blobs[i].h) < 1e-6);
  });
});
