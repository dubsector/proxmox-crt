// How the wax in the lava lamp moves: no drawing here, so it can be tested.
//
// The wax is a little denser than the liquid when cool and a little lighter
// when warm. The bulb under the glass heats the bottom; the top of the glass
// is cooler. So a blob of wax warmed at the bottom rises, cools as it goes,
// slows, turns and sinks, and is warmed again on the way down or back in the
// pool. Each blob warms and cools at its own pace (big ones slower), so no
// two keep step, and some turn back halfway. Where two meet the drawing
// melts them together (gl/lavalamp.js); where they part they pull apart.
//
// Heights are shares of the glass, 0 at the bottom and 1 at the top.

// How warm the liquid is at a height, for a lamp at `heat` (0 cold .. 1 hot).
// Wax at 0.5 neither rises nor sinks.
export function liquidWarmth(h, heat) {
  return heat * (0.42 - 0.3 * h);
}
// What the wax lying on the bulb's coil, at the bottom, is warmed toward.
var COIL = 1.25;
// How warm wax at the bottom must get before it lets go of the pool.
var LIFT = 0.95;

// Fastest a blob of the middle size climbs or sinks, in glass heights a
// second; a full climb takes most of half a minute.
var SPEED = 0.07;
// How long a blob takes to come up to speed, in seconds.
var DRAG_S = 1.6;

// The blobs: sizes are radii in the glass's units (its bottom is 0.52 wide).
export function createWax(count, seed) {
  var rand = mulberry(seed || 7);
  var blobs = [];
  for (var i = 0; i < count; i++) {
    var size = 0.09 + 0.14 * rand() * rand() + 0.05 * rand();
    blobs.push({
      size: size,
      // From the pool, at its own temperature, so they set off one by one.
      h: 0,
      v: 0,
      warmth: 0.2 + 0.5 * rand(),
      // Big wax holds its warmth longer.
      rate: (0.035 + 0.025 * rand()) * (0.15 / size),
      // Where it is around the glass and how far out, drifting slowly.
      turn: rand() * Math.PI * 2,
      spin: (rand() - 0.5) * 0.08,
      out: rand(),
      wander: 0.02 + 0.03 * rand(),
      phase: rand() * 100,
      // How much it is stretched along its way: 1 round.
      stretch: 1,
      // 0 free .. 1 sunk into the pool, when the lamp is cold.
      settled: 0,
    });
  }
  return { blobs: blobs, time: 0 };
}

// Moves the wax on by dt seconds for a lamp at `heat`. `floorOf(blob)` and
// `ceilingOf(blob)` are the lowest and highest heights its centre may reach.
export function stepWax(wax, dt, heat, floorOf, ceilingOf) {
  // Small steps, so a long frame does not throw the wax about.
  var n = Math.max(1, Math.ceil(dt / 0.05));
  var h = dt / n;
  for (var s = 0; s < n; s++) stepOnce(wax, h, heat, floorOf, ceilingOf);
}

function stepOnce(wax, dt, heat, floorOf, ceilingOf) {
  wax.time += dt;
  var t = wax.time;
  // Cooler wax is stiffer and slower.
  var ease = 0.3 + 0.7 * heat;
  wax.blobs.forEach(function (b) {
    // A slow wobble in each blob's warmth, as the liquid turns over.
    var stir = 0.05 * Math.sin(t * 0.07 + b.phase) + 0.03 * Math.sin(t * 0.19 + b.phase * 1.7);
    var lo = floorOf(b);
    var hi = ceilingOf(b);
    // Lying at the bottom it takes the coil's heat quickly; up in the
    // liquid it gives its warmth away slowly, faster at the cool top.
    var resting = Math.exp(-(b.h - lo) / 0.03);
    var around = (liquidWarmth(b.h, heat) + stir * heat) * (1 - resting) + COIL * heat * resting;
    var rate = b.rate * (1 + 7 * resting + 2 * b.h * b.h);
    b.warmth += (around - b.warmth) * (1 - Math.exp(-dt * rate));
    // Bigger blobs move faster (Stokes: with the square of their size,
    // softened so the small ones still get somewhere).
    var speed = SPEED * Math.pow(b.size / 0.15, 1.2) * ease;
    var goal = Math.max(-1, Math.min(1, (b.warmth - 0.5) * 2.6)) * speed;
    // Wax on the bottom clings to the pool until it has melted through.
    if (b.h - lo < 0.01 && b.warmth < LIFT) goal = Math.min(goal, 0);
    b.v += (goal - b.v) * (1 - Math.exp(-dt / DRAG_S));
    b.h += b.v * dt;
    if (b.h < lo) {
      b.h = lo;
      if (b.v < 0) b.v = 0;
    } else if (b.h > hi) {
      b.h = hi;
      if (b.v > 0) b.v = 0;
    }
    // Cold through, the wax at the bottom slumps into the pool; warm, it
    // swells out of it again before it lifts.
    var down = b.h - lo < 0.02 && b.warmth < 0.5;
    var sink = down ? Math.max(0, Math.min(1, (0.5 - heat) / 0.3)) : 0;
    b.settled += (sink - b.settled) * (1 - Math.exp(-dt / 6));
    b.turn += b.spin * dt * ease;
    b.out = 0.5 + 0.5 * Math.sin(t * b.wander + b.phase);
    // Long while it moves, round where it rests; it swells as it warms.
    var fast = Math.min(1, Math.abs(b.v) / SPEED);
    b.stretch += (1 + 0.55 * fast - b.stretch) * (1 - Math.exp(-dt / 1.2));
  });
}

// How much of the wax lies in the pool, 0..1 (all of it, cold).
export function pooled(wax) {
  var all = 0;
  var lying = 0;
  wax.blobs.forEach(function (b) {
    var m = b.size * b.size * b.size;
    all += m;
    lying += m * b.settled;
  });
  return all ? lying / all : 0;
}

function mulberry(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
