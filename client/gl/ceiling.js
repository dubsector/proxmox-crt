// The office's ceiling lights: how bright they are, and how they come on.
// The visit starts with the room dark, only the screens, the boards and the
// lamps giving light. Then the fluorescent tubes overhead are switched on
// and do what tubes on cold starters do: the filaments warm, they strike
// and drop out, strike again with the arc fluttering, catch, and creep up
// to full brightness as they warm. The same start-up as terminal's room.

// How bright the tubes are once warm, as a share of the bake. The bake is
// lit for a bright office; a firing room at night runs much darker.
export var CEILING_FULL = 0.25;
// What is left of the room's baked light with the tubes off: the spill of
// the signs and gear that the bake folded into the room pass.
export var CEILING_DARK = 0.03;
// How long the room sits dark before the tubes are switched on.
export var CEILING_HOLD_S = 1.6;
// Each step is one strike of the tubes, in seconds after the switch:
// [from, to, brightness at the start, at the end, depth of the flutter].
// Between steps they are out; after the last they have caught and warm up
// the rest of the way with CEILING_WARM_S. Big changes stay at three a
// second or fewer, and the flutter shallow, so it never strobes.
export var CEILING_STEPS = [
  [0.0, 0.06, 0.6, 0.5, 0.1],
  [0.5, 0.66, 0.75, 0.62, 0.12],
  [1.25, 1.8, 0.7, 0.78, 0.1],
  [1.8, 1.9, 0.5, 0.48, 0.06],
  [1.9, 2.4, 0.74, 0.86, 0.08],
];
export var CEILING_WARM_S = 0.9;

// How far on the tubes are, t seconds after the room first showed:
// 0 is off, 1 is fully warm. reduced: no flashing, the same dark start,
// then a plain fade up.
export function ceilingLevel(t, reduced) {
  if (reduced) {
    var f = Math.min(Math.max((t - CEILING_HOLD_S) / 1.2, 0), 1);
    return f * f * (3 - 2 * f);
  }
  t -= CEILING_HOLD_S;
  if (t < 0) return 0;
  for (var i = 0; i < CEILING_STEPS.length; i++) {
    var s = CEILING_STEPS[i];
    if (t < s[0]) break;
    if (t < s[1]) {
      // Within a strike: the arc's brightness, with the flutter of a tube
      // that has not settled yet riding on it.
      var k = (t - s[0]) / (s[1] - s[0]);
      return (s[2] + (s[3] - s[2]) * k) * (1 - s[4] * flutter(t));
    }
  }
  var last = CEILING_STEPS[CEILING_STEPS.length - 1];
  if (t < last[1]) return 0;
  // Caught. A cold tube gives a little short of its full light, and comes
  // up the rest of the way over a few seconds.
  var w = t - last[1];
  if (w > CEILING_WARM_S * 6) return 1;
  return last[3] + (1 - last[3]) * (1 - Math.exp(-w / CEILING_WARM_S));
}

// Irregular 0..1 wobble: a few incommensurate beats, not a regular buzz.
function flutter(t) {
  var v = Math.sin(t * 61.0) * 0.5 + Math.sin(t * 23.7 + 1.3) * 0.3 + Math.sin(t * 97.1 + 0.4) * 0.2;
  return 0.5 + 0.5 * v;
}

// The room pass's level for a ceiling that is `on` of the way on.
export function roomLevel(on) {
  return CEILING_DARK + (CEILING_FULL - CEILING_DARK) * on;
}

// Steps the start-up. step(dt) returns the room pass's level, and whether
// the light is still changing.
export function createCeiling(reduced) {
  var t = -1;
  var done = false;
  return {
    step: function (dt) {
      if (done) return { level: roomLevel(1), changing: false };
      t = t < 0 ? 0 : t + dt;
      var on = ceilingLevel(t, reduced);
      if (t > CEILING_HOLD_S && on >= 1) done = true;
      return { level: roomLevel(on), changing: !done };
    },
    done: function () {
      return done;
    },
  };
}
