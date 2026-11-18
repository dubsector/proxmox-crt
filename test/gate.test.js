import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { wrongDoor, cardOpen } from "../client/gate.js";

test("a page opened over plain http says so where the cookies are for https alone", function () {
  var https = { configured: true, authed: false, https_only: true };
  assert.equal(wrongDoor(https, false), true);
  // Over https, or on the machine itself, the cookies are kept.
  assert.equal(wrongDoor(https, true), false);
  // A browser too old to say is not turned away on a guess.
  assert.equal(wrongDoor(https, undefined), false);
  // A bridge on a plain LAN, or one that does not say, takes the password
  // wherever the page is.
  assert.equal(wrongDoor({ configured: true, authed: false, https_only: false }, false), false);
  assert.equal(wrongDoor({ configured: true, authed: false }, false), false);
});

test("no card is up until one is raised", function () {
  assert.equal(cardOpen(), false);
});

// The layer the stylesheet puts `selector`'s element on.
function layer(css, selector) {
  var rules = css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g);
  for (var rule of rules) {
    var named = rule[1].split(",").some(function (one) {
      return one.trim() === selector;
    });
    var z = /z-index:\s*(\d+)/.exec(rule[2]);
    if (named && z) return Number(z[1]);
  }
  assert.fail("no z-index for " + selector);
}

test("a card lies over the touch keypad, so nothing under it can be pressed", function () {
  var css = readFileSync(new URL("../client/style.css", import.meta.url), "utf8");
  var card = layer(css, ".gate");
  assert.ok(card > layer(css, "#pad"), "over the keypad");
  assert.ok(card > layer(css, "#padToggle"), "over the keypad's button");
  assert.ok(card > layer(css, "#security"), "over the corner button");
  // The word to a phone held upright still covers everything.
  assert.ok(layer(css, "#rotate") > card);
});
