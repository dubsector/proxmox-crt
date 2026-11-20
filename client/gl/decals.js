// What is printed on the desk's gear: the keypad's legends and the engraved
// labels. As with the keyboard's legends (legends.js), the baked maps carry
// the colour of the part and the printing is drawn here at load, on a
// canvas, and multiplied over it; white means "nothing printed".
//
// Each printed part's node says what goes where in its `decals` property
// (tools/blender/vt_office.py Gear): [{ cell, span, text, style, w, h }],
// the print's size on the part in millimetres.
import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace } from "three";

// The sheet the parts' first UV set addresses: 8 x 8 cells, numbered left
// to right, top row first. A print takes `span` cells of a row, less a
// small border; the last row is left blank for everything unprinted.
var CELLS = 8;
var CELL_PX = 256;
var INSET = 0.03;
var FONT = 'system-ui, "Helvetica Neue", Helvetica, Arial, sans-serif';
var KEY_INK = "#262422";
// An engraved label: black laminate cut through to its light core. The
// part itself is the core's colour, so the letters are left white.
var PLATE_FACE = "#17181a";

var STYLES = {
  // A key cap: one large glyph in the middle.
  key: function (ctx, d) {
    ctx.fillStyle = KEY_INK;
    ctx.font = "500 " + Math.min(d.h * 0.46, d.w * 0.6) + "px " + FONT;
    ctx.fillText(d.text, d.w / 2, d.h * 0.52, d.w * 0.8);
  },
  // A label: capitals, spaced out, across the middle of the plate.
  plate: function (ctx, d) {
    var size = d.h * 0.56;
    ctx.fillStyle = "#fff";
    ctx.font = "600 " + size + "px " + FONT;
    if ("letterSpacing" in ctx) ctx.letterSpacing = size * 0.14 + "px";
    ctx.fillText(d.text, d.w / 2 + size * 0.07, d.h * 0.53, d.w * 0.86);
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
  },
};

export function decalsOf(node) {
  var raw = node.userData && node.userData.decals;
  if (!raw) return [];
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    return [];
  }
}

// `nodes` are the model's printed parts. Returns the sheet's texture.
export function drawDecals(nodes, anisotropy) {
  var canvas = document.createElement("canvas");
  canvas.width = canvas.height = CELLS * CELL_PX;
  var ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  nodes.forEach(function (node) {
    decalsOf(node).forEach(function (d) {
      var col = d.cell % CELLS;
      var row = Math.floor(d.cell / CELLS);
      var span = d.span || 1;
      if (d.style === "plate") {
        // Past the print's own edge, so that nothing white bleeds in.
        ctx.fillStyle = PLATE_FACE;
        ctx.fillRect(col * CELL_PX, row * CELL_PX, span * CELL_PX, CELL_PX);
      }
      var draw = STYLES[d.style];
      if (!draw || !d.text) return;
      ctx.save();
      // Millimetres on the part from here on.
      ctx.setTransform(((span - 2 * INSET) * CELL_PX) / d.w, 0, 0, ((1 - 2 * INSET) * CELL_PX) / d.h, (col + INSET) * CELL_PX, (row + INSET) * CELL_PX);
      draw(ctx, d);
      ctx.restore();
    });
  });
  var tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  // glTF texture coordinates have their origin at the top left, like the canvas.
  tex.flipY = false;
  tex.generateMipmaps = true;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.anisotropy = anisotropy;
  return tex;
}
