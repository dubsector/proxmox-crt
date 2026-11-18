// Colour on a one-colour tube. A program's colours cannot be shown, but how
// light or dark they are can: a monochrome display hung on a colour card
// showed each colour as a shade. So a menu's selected line, a dialog and the
// screen behind it stay apart, as they do in colour.
import { BOLD, DIM, INVERSE, BACK_LOW, BACK_MID } from "./gl/textgrid.js";

// xterm.js's own sixteen colours, with black as the tube's black.
var ANSI = [0x000000, 0xcc0000, 0x4e9a06, 0xc4a000, 0x3465a4, 0x75507b, 0x06989a, 0xd3d7cf, 0x555753, 0xef2929, 0x8ae234, 0xfce94f, 0x729fcf, 0xad7fa8, 0x34e2e2, 0xeeeeec];
var CUBE = [0, 95, 135, 175, 215, 255];

// How light an 0xRRGGBB colour is, 0 to 1.
export function lightness(rgb) {
  return (0.2126 * ((rgb >> 16) & 255) + 0.7152 * ((rgb >> 8) & 255) + 0.0722 * (rgb & 255)) / 255;
}

// One of the 256 palette colours as 0xRRGGBB.
export function paletteColor(n) {
  if (n < 16) return ANSI[n];
  if (n < 232) {
    var c = n - 16;
    return (CUBE[Math.floor(c / 36)] << 16) | (CUBE[Math.floor(c / 6) % 6] << 8) | CUBE[c % 6];
  }
  var g = 8 + (n - 232) * 10;
  return (g << 16) | (g << 8) | g;
}

// What a cell with this text and background looks like on the tube.
// fore and back are lightnesses (0 to 1); back is 0 for the screen's own
// black. Returns { attr, back }: the grid's attribute bits and the level
// its background glows at.
export function shade(fore, back, bold, dim) {
  var weight = bold ? BOLD : dim ? DIM : 0;
  // On black, the text is as bright as the program asked.
  if (back < 0.05) return { attr: weight, back: 0 };
  // Dark text on a lit ground: the ground glows and the letters are cut out
  // of it, brighter for a lighter colour.
  if (fore <= back) return { attr: INVERSE | (back > 0.85 ? BOLD : back < 0.3 ? DIM : 0), back: 0 };
  // Light text on a colour: bright letters on a faint glow.
  return { attr: BOLD, back: back < 0.3 ? BACK_LOW : BACK_MID };
}
