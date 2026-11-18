import { test } from "node:test";
import assert from "node:assert/strict";
import { createGrid, paintGrid, BOLD, DIM, INVERSE, BACK_LOW, BACK_MID } from "../client/gl/textgrid.js";
import { lightness, paletteColor, shade } from "../client/mono.js";

function look(fg, bg, bold) {
  return shade(lightness(paletteColor(fg)), bg === null ? 0 : lightness(paletteColor(bg)), !!bold, false);
}

test("text on black keeps its weight and has no ground", function () {
  assert.deepEqual(look(7, null), { attr: 0, back: 0 });
  assert.deepEqual(look(7, null, true), { attr: BOLD, back: 0 });
});

test("a dialog, the screen behind it and its selected line are three shades", function () {
  var root = look(7, 4); // grey on blue
  var box = look(0, 7); // black on grey
  var picked = look(15, 4); // white on blue
  var button = look(0, 1); // black on red
  assert.deepEqual(root, { attr: BOLD, back: BACK_MID });
  assert.deepEqual(box, { attr: INVERSE, back: 0 });
  assert.deepEqual(picked, { attr: BOLD, back: BACK_MID });
  assert.deepEqual(button, { attr: INVERSE | DIM, back: 0 });
  assert.notDeepEqual(box, picked);
  assert.notDeepEqual(box, button);
});

test("light text on a dark colour glows less than on a middling one", function () {
  assert.equal(look(15, 1).back, BACK_LOW);
});

test("the 256 colours: cube and greys", function () {
  assert.equal(paletteColor(196), 0xff0000);
  assert.equal(paletteColor(232), 0x080808);
  assert.equal(paletteColor(255), 0xeeeeee);
});

test("a ground is painted behind the character, and inverse swaps them", function () {
  var grid = createGrid(1, 1);
  grid.put(0, 0, " ", BOLD);
  grid.backs[0] = BACK_LOW;
  var out = new Uint8Array(9 * 14);
  paintGrid(grid, out, 9, 14, 1);
  assert.ok(out.every(function (v) { return v === BACK_LOW; }));
  grid.attrs[0] = BOLD | INVERSE;
  paintGrid(grid, out, 9, 14, 1);
  assert.ok(out.every(function (v) { return v === 255; }));
  grid.put(0, 0, " ", INVERSE);
  paintGrid(grid, out, 9, 14, 1);
  assert.ok(out.every(function (v) { return v === 184; }));
});
