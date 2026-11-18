// What a tube does when it is switched on and off, as numbers the face
// shader draws. One of these per set; the desk terminal and every wall
// monitor step their own.
//
// Off: with vertical deflection gone the raster folds to a line in a
// fraction of a second while the gun is still emitting, so the same beam
// current lands on a tiny area and the line is far brighter than the picture
// was. Horizontal scan follows, leaving a spot that the still-hot cathode
// keeps feeding for a second or two.
//
// On: the scan circuits are at full size almost at once, but the cathode
// has to heat before there is any beam: a dark, full-size raster, then
// brightness coming up, the picture a touch oversized while the high
// voltage settles.

var WARM_DARK_S = 1.3;
var WARM_RISE_S = 1.6;

export function createPower(on) {
  return {
    state: on ? "on" : "off", // "off" | "warming" | "on" | "collapsing"
    t: 0,
    gain: on ? 1 : 0, // beam drive, 0-1
    breath: 1, // raster size about its centre
    line: 0, // brightness of the collapsing line
    lineV: 1, // its height, 0-1 of the raster
    lineH: 1, // its width
    spot: 0, // brightness of the dot it ends in
    collapseGain: 1,
  };
}

export function setPower(p, on) {
  if (on && (p.state === "on" || p.state === "warming")) return;
  if (!on && (p.state === "off" || p.state === "collapsing")) return;
  if (!on) p.collapseGain = p.gain;
  p.state = on ? "warming" : "collapsing";
  p.t = 0;
}

// Skips the animation (reduced motion, or a set that should simply be on).
export function snapPower(p, on) {
  p.state = on ? "on" : "off";
  p.t = 0;
  p.gain = on ? 1 : 0;
  p.breath = 1;
  p.line = 0;
  p.spot = 0;
}

// Moves the set on by dt seconds. `apl` is the average picture level, which
// sets how bright the collapsing line is. Returns true while it is changing.
export function stepPower(p, dt, apl) {
  if (p.state === "on" || p.state === "off") return false;
  p.t += dt;
  if (p.state === "collapsing") {
    p.gain = 0;
    var a = Math.min(p.t / 0.16, 1);
    var b = Math.min(Math.max((p.t - 0.16) / 0.3, 0), 1);
    p.lineV = Math.max(Math.pow(1 - a, 2.2), 0.004);
    p.lineH = Math.max(1 - b * b * 0.985, 0.015);
    // Same beam current on a shrinking area: brightness goes up as the lit
    // area goes down, until the phosphor saturates.
    var area = p.lineV * p.lineH;
    p.line = b < 1 ? Math.min((0.02 + (apl || 0) * 0.9) / area, 4.5) * p.collapseGain : 0;
    var s = p.t - 0.46;
    p.spot = s > 0 ? (2.2 * Math.exp(-s / 0.5) + 0.25 * Math.exp(-s / 1.8)) * p.collapseGain : 0;
    if (s > 6) {
      p.spot = 0;
      p.state = "off";
    }
  } else {
    // Switched back on mid-collapse: what's left of the line and spot dies
    // away rather than vanishing.
    p.line *= Math.exp(-dt / 0.05);
    p.spot *= Math.exp(-dt / 0.3);
    var w = Math.min(Math.max((p.t - WARM_DARK_S) / WARM_RISE_S, 0), 1);
    p.gain = w * w * (3 - 2 * w);
    p.breath = 1 + 0.015 * (1 - p.gain);
    if (w >= 1) {
      p.state = "on";
      p.breath = 1;
      p.line = 0;
      p.spot = 0;
    }
  }
  return true;
}
