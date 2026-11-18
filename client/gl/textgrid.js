// A screenful of characters and the video signal a text display's character
// generator would make of it: for every dot of the raster, how hard the beam
// is driven (0-255).
//
// A monochrome display has no fonts and no weights. The character ROM holds
// one dot pattern per character; "bold" and "dim" are the video amplifier
// driving the same dots harder or softer, and underline is one extra lit
// scanline near the bottom of the cell. (From dubsector/terminal's painter,
// which reads an xterm buffer; this one reads a plain grid.)
import { FONT_W, FONT_H, GLYPHS } from "./font9x14.js";

export var BOLD = 1;
export var DIM = 2;
export var INVERSE = 4;
export var UNDERLINE = 8;

var LEVEL_NORMAL = 184;
var LEVEL_BOLD = 255;
var LEVEL_DIM = 97;
var UNDERLINE_ROW = 12;

var cache = {};

// Bar-graph characters the ROM doesn't have: the cell filled from the
// bottom up, one eighth more each (U+2581 to U+2587). The full block is in
// the ROM already.
function eighths(n) {
  var rows = Math.round((FONT_H * n) / 8);
  var g = new Uint8Array(FONT_W * FONT_H);
  for (var y = FONT_H - rows; y < FONT_H; y++) {
    for (var x = 0; x < FONT_W; x++) g[y * FONT_W + x] = 1;
  }
  return g;
}

// A gauge's two characters. A full block would run into the row above and
// below it, so two gauges on neighbouring rows would read as one shape:
// these stop short of the cell's top and bottom. They do fill its width, so
// a run of them joins into one bar.
export var GAUGE_ON = "\u25ac";
export var GAUGE_OFF = "\u25ad";
function gauge(on) {
  var g = new Uint8Array(FONT_W * FONT_H);
  for (var y = 3; y <= 10; y++) {
    for (var x = 0; x < FONT_W; x++) {
      // The unlit part is a sparse grid of dots: the track the bar runs in.
      if (on || (y % 3 === 0 && x % 3 === 1)) g[y * FONT_W + x] = 1;
    }
  }
  return g;
}

// Line-drawing characters, which a guest's programs frame things with:
// which of the four arms (up, down, left, right) each has. The ROM here has
// none, and a system font's would not meet from cell to cell, so they are
// drawn: one dot wide, through the middle of the cell. Heavy and double
// lines come out as single ones.
var LINES = {};
[
  ["\u2500\u2501\u2550\u254c\u2504\u2508", "lr"],
  ["\u2502\u2503\u2551\u254e\u2506\u250a", "ud"],
  ["\u250c\u250f\u2554\u256d", "dr"],
  ["\u2510\u2513\u2557\u256e", "dl"],
  ["\u2514\u2517\u255a\u2570", "ur"],
  ["\u2518\u251b\u255d\u256f", "ul"],
  ["\u251c\u2523\u2560", "udr"],
  ["\u2524\u252b\u2563", "udl"],
  ["\u252c\u2533\u2566", "dlr"],
  ["\u2534\u253b\u2569", "ulr"],
  ["\u253c\u254b\u256c", "udlr"],
].forEach(function (row) {
  for (var i = 0; i < row[0].length; i++) LINES[row[0][i]] = row[1];
});
var MID_X = 4;
var MID_Y = 7;
function lines(arms) {
  var g = new Uint8Array(FONT_W * FONT_H);
  var x, y;
  if (arms.indexOf("u") >= 0) for (y = 0; y <= MID_Y; y++) g[y * FONT_W + MID_X] = 1;
  if (arms.indexOf("d") >= 0) for (y = MID_Y; y < FONT_H; y++) g[y * FONT_W + MID_X] = 1;
  if (arms.indexOf("l") >= 0) for (x = 0; x <= MID_X; x++) g[MID_Y * FONT_W + x] = 1;
  if (arms.indexOf("r") >= 0) for (x = MID_X; x < FONT_W; x++) g[MID_Y * FONT_W + x] = 1;
  return g;
}

// Anything else the ROM lacks (accented letters, bullets, arrows) is drawn
// once from a system font and thresholded to dots. No real character
// generator worked like this, but it beats a blank. Outside a browser, and
// for characters the font draws nothing for, there is no pattern.
var drawCtx = null;
function drawn(ch) {
  if (typeof document === "undefined") return null;
  if (!drawCtx) {
    var c = document.createElement("canvas");
    c.width = FONT_W;
    c.height = FONT_H;
    drawCtx = c.getContext("2d", { willReadFrequently: true });
    if (!drawCtx) return null;
    drawCtx.textBaseline = "alphabetic";
    drawCtx.textAlign = "center";
  }
  drawCtx.clearRect(0, 0, FONT_W, FONT_H);
  drawCtx.fillStyle = "#fff";
  drawCtx.font = "11px monospace";
  drawCtx.fillText(ch, (FONT_W - 1) / 2, 11);
  var px = drawCtx.getImageData(0, 0, FONT_W, FONT_H).data;
  var g = new Uint8Array(FONT_W * FONT_H);
  var any = false;
  for (var i = 0; i < g.length; i++) {
    if (px[i * 4 + 3] > 96) {
      g[i] = 1;
      any = true;
    }
  }
  return any ? g : null;
}

function glyphFor(ch) {
  var g = cache[ch];
  if (g) return g;
  var rows = GLYPHS[ch];
  var code = ch.charCodeAt(0);
  if (rows) {
    g = new Uint8Array(FONT_W * FONT_H);
    for (var y = 0; y < FONT_H; y++) {
      for (var x = 0; x < FONT_W; x++) {
        if (rows[y].charCodeAt(x) === 35) g[y * FONT_W + x] = 1;
      }
    }
  } else if (ch === GAUGE_ON || ch === GAUGE_OFF) {
    g = gauge(ch === GAUGE_ON);
  } else if (code >= 0x2581 && code <= 0x2587) {
    g = eighths(code - 0x2580);
  } else if (LINES[ch]) {
    g = lines(LINES[ch]);
  } else if ((g = drawn(ch))) {
    // Rasterised from a system font, below.
  } else {
    // Not in the ROM: a small centred box, the way a terminal shows a
    // character it has no pattern for.
    g = new Uint8Array(FONT_W * FONT_H);
    for (var by = 4; by < 10; by++) {
      for (var bx = 2; bx < 7; bx++) {
        if (by === 4 || by === 9 || bx === 2 || bx === 6) g[by * FONT_W + bx] = 1;
      }
    }
  }
  cache[ch] = g;
  return g;
}

export function createGrid(cols, rows) {
  var chars = new Array(cols * rows).fill(" ");
  var attrs = new Uint8Array(cols * rows);
  var grid = {
    cols: cols,
    rows: rows,
    chars: chars,
    attrs: attrs,
    clear: function () {
      chars.fill(" ");
      attrs.fill(0);
      return grid;
    },
    // Writes text on one row from column x; what runs off the edge is cut.
    put: function (x, y, text, attr) {
      if (y < 0 || y >= rows) return grid;
      var s = String(text);
      for (var i = 0; i < s.length; i++) {
        var cx = x + i;
        if (cx < 0 || cx >= cols) continue;
        chars[y * cols + cx] = s[i];
        attrs[y * cols + cx] = attr || 0;
      }
      return grid;
    },
    // Sets an attribute on a run of cells without changing their characters.
    paint: function (x, y, length, attr) {
      for (var i = 0; i < length; i++) {
        var cx = x + i;
        if (cx >= 0 && cx < cols && y >= 0 && y < rows) attrs[y * cols + cx] = attr;
      }
      return grid;
    },
    // Everything on the screen as one string: what changed, changed here.
    key: function () {
      return chars.join("") + "|" + Array.prototype.join.call(attrs, "");
    },
    // The rows as text, for tests and for the flat page.
    lines: function () {
      var out = [];
      for (var r = 0; r < rows; r++) out.push(chars.slice(r * cols, (r + 1) * cols).join(""));
      return out;
    },
  };
  return grid;
}

// Draws the grid into `out` (width x height, one byte per dot, first row at
// the top), each ROM dot `scale` raster dots square, the block of text
// centred. Returns the average picture level (0-1): how much of the screen
// is lit, which is what the light the tube throws on the room follows.
export function paintGrid(grid, out, width, height, scale) {
  var s = scale || 1;
  var cw = FONT_W * s;
  var chh = FONT_H * s;
  var ox = Math.max(0, Math.floor((width - grid.cols * cw) / 2));
  var oy = Math.max(0, Math.floor((height - grid.rows * chh) / 2));
  var sum = 0;
  out.fill(0);
  for (var row = 0; row < grid.rows; row++) {
    for (var col = 0; col < grid.cols; col++) {
      var idx = row * grid.cols + col;
      var ch = grid.chars[idx];
      var attr = grid.attrs[idx];
      var inverse = (attr & INVERSE) !== 0;
      var underline = (attr & UNDERLINE) !== 0;
      if (ch === " " && !inverse && !underline) continue;
      var level = attr & BOLD ? LEVEL_BOLD : attr & DIM ? LEVEL_DIM : LEVEL_NORMAL;
      var glyph = ch === " " ? null : glyphFor(ch);
      var x0 = ox + col * cw;
      var y0 = oy + row * chh;
      for (var gy = 0; gy < FONT_H; gy++) {
        for (var gx = 0; gx < FONT_W; gx++) {
          var lit = glyph ? glyph[gy * FONT_W + gx] === 1 : false;
          if (underline && gy === UNDERLINE_ROW) lit = true;
          if (inverse) lit = !lit;
          if (!lit) continue;
          for (var sy = 0; sy < s; sy++) {
            var py = y0 + gy * s + sy;
            if (py >= height) break;
            var off = py * width + x0 + gx * s;
            for (var sx = 0; sx < s; sx++) {
              if (x0 + gx * s + sx < width) out[off + sx] = level;
            }
          }
          sum += level * s * s;
        }
      }
    }
  }
  return sum / (255 * width * height);
}
