import { test } from "node:test";
import assert from "node:assert/strict";
import { keyBytes, MODIFIERS } from "../client/keymap.js";

test("letters follow Shift and Lock, and Ctrl makes control codes", () => {
  assert.equal(keyBytes("KeyA"), "a");
  assert.equal(keyBytes("KeyA", { shift: true }), "A");
  assert.equal(keyBytes("KeyA", { lock: true }), "A");
  assert.equal(keyBytes("KeyA", { lock: true, shift: true }), "a");
  assert.equal(keyBytes("KeyC", { ctrl: true }), "\x03");
  assert.equal(keyBytes("KeyD", { ctrl: true, shift: true }), "\x04");
});

test("glyph keys give their shifted glyph with Shift", () => {
  assert.equal(keyBytes("Digit1"), "1");
  assert.equal(keyBytes("Digit1", { shift: true }), "!");
  assert.equal(keyBytes("Slash", { shift: true }), "?");
  assert.equal(keyBytes("Quote", { shift: true }), '"');
  assert.equal(keyBytes("Space"), " ");
  assert.equal(keyBytes("Space", { ctrl: true }), "\x00");
  assert.equal(keyBytes("BracketLeft", { ctrl: true }), "\x1b");
  assert.equal(keyBytes("Backslash", { ctrl: true }), "\x1c");
});

test("the editing keys do what their caps say", () => {
  assert.equal(keyBytes("Enter"), "\r");
  assert.equal(keyBytes("Backspace"), "\x7f");
  assert.equal(keyBytes("Tab"), "\t");
  assert.equal(keyBytes("F11"), "\x1b");
  assert.equal(keyBytes("Home"), "\x1b[2~");
  assert.equal(keyBytes("PageDown"), "\x1b[6~");
});

test("cursor keys follow the cursor key mode", () => {
  assert.equal(keyBytes("ArrowUp"), "\x1b[A");
  assert.equal(keyBytes("ArrowLeft", { appCursor: true }), "\x1bOD");
});

test("Alt puts Escape first; modifiers and the terminal's own keys send nothing", () => {
  assert.equal(keyBytes("KeyB", { alt: true }), "\x1bb");
  assert.equal(keyBytes("ShiftLeft"), "");
  assert.equal(keyBytes("VT_SetUp"), "");
  assert.equal(MODIFIERS.CapsLock, "lock");
  assert.equal(MODIFIERS.ControlLeft, "ctrl");
});
