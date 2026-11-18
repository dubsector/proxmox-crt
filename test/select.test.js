import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeypad, guardedKey } from "../client/select.js";

function pad(count, columns) {
  var picked = [];
  var entries = [];
  var timers = [];
  var k = createKeypad({
    count: count,
    columns: columns || 13,
    onSelect: function (n) {
      picked.push(n);
    },
    onEntry: function (text, bad) {
      entries.push([text, bad]);
    },
    setTimer: function (fn) {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: function (id) {
      timers[id - 1] = null;
    },
  });
  return {
    k: k,
    picked: picked,
    entries: entries,
    // Lets the pause after a single digit run out.
    pause: function () {
      timers.splice(0).forEach(function (fn) {
        if (fn) fn();
      });
    },
  };
}

test("two digits select at once", function () {
  var p = pad(48);
  assert.equal(p.k.key("Numpad0"), true);
  assert.deepEqual(p.picked, []);
  p.k.key("Numpad7");
  assert.deepEqual(p.picked, [7]);
  assert.equal(p.k.selected(), 7);
  assert.equal(p.k.entry(), "");
});

test("one digit selects after the pause, or on Enter", function () {
  var p = pad(48);
  p.k.key("Numpad4");
  assert.deepEqual(p.picked, []);
  p.pause();
  assert.deepEqual(p.picked, [4]);
  p.k.key("Numpad9");
  p.k.key("NumpadEnter");
  assert.deepEqual(p.picked, [4, 9]);
  // The pause that was pending must not select again.
  p.pause();
  assert.deepEqual(p.picked, [4, 9]);
});

test("a number with no monitor is refused and says so", function () {
  var p = pad(48);
  p.k.key("Numpad9");
  p.k.key("Numpad9");
  assert.deepEqual(p.picked, []);
  assert.deepEqual(p.entries.at(-1), ["", true]);
  p.k.key("Numpad0");
  p.k.key("Numpad0");
  assert.deepEqual(p.picked, []);
  assert.equal(p.k.selected(), 0);
});

test("a wall of nine or fewer takes one digit", function () {
  var p = pad(9, 4);
  p.k.key("Numpad3");
  assert.deepEqual(p.picked, [3]);
});

test("plus and minus step and wrap", function () {
  var p = pad(3, 3);
  p.k.key("NumpadAdd");
  p.k.key("NumpadAdd");
  p.k.key("NumpadAdd");
  p.k.key("NumpadAdd");
  assert.deepEqual(p.picked, [1, 2, 3, 1]);
  p.k.key("NumpadSubtract");
  assert.deepEqual(p.picked.at(-1), 3);
});

test("minus with nothing selected goes to the last monitor", function () {
  var p = pad(48);
  p.k.key("NumpadSubtract");
  assert.deepEqual(p.picked, [48]);
});

test("up and down move by a row and stop at the edge", function () {
  var p = pad(48, 13);
  p.k.pick(2);
  p.k.key("ArrowDown");
  assert.equal(p.k.selected(), 15);
  p.k.key("ArrowUp");
  p.k.key("ArrowUp");
  assert.equal(p.k.selected(), 2);
  p.k.pick(40);
  p.k.key("ArrowDown");
  assert.equal(p.k.selected(), 40);
});

test("a click cancels a number being typed", function () {
  var p = pad(48);
  p.k.key("Numpad1");
  p.k.pick(30);
  p.pause();
  assert.deepEqual(p.picked, [30]);
});

test("other keys are left alone", function () {
  var p = pad(48);
  assert.equal(p.k.key("KeyA"), false);
  assert.equal(p.k.key("Digit1"), false);
});

test("shrinking the wall drops a selection that no longer exists", function () {
  var p = pad(48);
  p.k.pick(40);
  p.k.resize(12, 4);
  assert.equal(p.k.selected(), 0);
});

test("clearing selects nothing and drops a number being typed", function () {
  var p = pad(48);
  p.k.pick(5);
  p.k.key("Numpad7");
  p.k.clear();
  assert.equal(p.k.selected(), 0);
  assert.equal(p.k.entry(), "");
  assert.deepEqual(p.entries.at(-1), ["", false]);
  // The pause that was pending must not select later.
  p.pause();
  assert.deepEqual(p.picked, [5]);
  assert.equal(p.k.selected(), 0);
});

test("with the guard up, Enter throws the switch only with no number waiting", function () {
  assert.equal(guardedKey("NumpadEnter", false), "throw");
  assert.equal(guardedKey("NumpadEnter", true), "shut");
  assert.equal(guardedKey("Power", false), "throw");
  assert.equal(guardedKey("Power", true), "throw");
  assert.equal(guardedKey("NumpadDivide", false), "cut");
});

test("with the guard up, a digit shuts it and other keys are not its business", function () {
  assert.equal(guardedKey("Numpad7", false), "shut");
  assert.equal(guardedKey("Numpad0", true), "shut");
  assert.equal(guardedKey("NumpadAdd", false), null);
  assert.equal(guardedKey("NumpadDecimal", false), null);
  assert.equal(guardedKey("KeyA", false), null);
});

test("a digit typed with the guard up, then Enter, selects that monitor", function () {
  var p = pad(48);
  p.k.pick(5);
  assert.equal(guardedKey("Numpad7", p.k.entry() !== ""), "shut");
  p.k.key("Numpad7");
  assert.equal(guardedKey("NumpadEnter", p.k.entry() !== ""), "shut");
  p.k.key("NumpadEnter");
  assert.equal(p.k.selected(), 7);
});
