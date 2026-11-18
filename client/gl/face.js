// The face of a tube: curved glass with the room in it, the phosphor behind
// it, and the picture the beam draws. From dubsector/terminal's scene.js,
// where it was written for one set; here the same shader comes in two forms.
//
//   desk: one set, its picture read from a phosphor-state texture that a
//         separate pass keeps (see tube.js), power state in uniforms.
//   wall: many sets in one draw call. Each instance reads its own layer of
//         an array texture and carries its own power state as attributes.
import { ShaderMaterial, PlaneGeometry, Color, Vector3 } from "three";
import { RASTER, RASTER_GLSL } from "./raster.js";

// Bezel opening (the visible part of the tube face), in tube units. A
// 12-inch 4:3 tube shows roughly 244 x 183 mm, so one unit is about 61 mm.
export var FACE_HALF_W = 2.0;
export var FACE_HALF_H = 1.5;
// Radius of the spherical faceplate, and how far its apex stands proud.
var FACE_RADIUS = 11.0;
export var FACE_APEX_Z = 0.05;
// Distance from the outer glass surface to the phosphor layer, already
// divided by the refractive index (about 10 mm of glass, n = 1.5).
export var GLASS_DEPTH = 0.11;
// How much of the phosphor's light the tinted faceplate lets through, and
// the drive level of a fully lit dot.
export var GLASS_T = 0.62;
export var EMISSION_GAIN = 1.25;

export var PHOSPHORS = {
  green: [0.1, 1.0, 0.2],
  amber: [1.0, 0.55, 0.05],
  white: [0.82, 0.9, 1.0],
};

function f(n, digits) {
  return n.toFixed(digits === undefined ? 3 : digits);
}

var VERT = [
  "varying vec2 vP;",
  "varying vec3 vWN;",
  "varying vec3 vWP;",
  "#ifdef WALL",
  "attribute float aLayer;",
  "attribute vec4 aBeam;",
  "attribute vec4 aLine;",
  "varying float vLayer;",
  "varying vec4 vBeam;",
  "varying vec4 vLine;",
  "#endif",
  "void main(){",
  "  vP = position.xy / vec2(" + f(FACE_HALF_W) + "," + f(FACE_HALF_H) + ");",
  "  mat4 m = modelMatrix;",
  "#ifdef USE_INSTANCING",
  "  m = modelMatrix * instanceMatrix;",
  "#endif",
  "#ifdef WALL",
  "  vLayer = aLayer; vBeam = aBeam; vLine = aLine;",
  "#endif",
  "  vWN = normalize(mat3(m) * normal);",
  "  vec4 wp = m * vec4(position, 1.0);",
  "  vWP = wp.xyz;",
  "  gl_Position = projectionMatrix * viewMatrix * wp;",
  "}",
].join("\n");

function fragment(width, height) {
  return [
    "precision highp sampler2DArray;",
    "#ifdef WALL",
    "uniform sampler2DArray uSig;",
    "varying float vLayer;",
    "varying vec4 vBeam;",
    "varying vec4 vLine;",
    "#else",
    "uniform sampler2D uSig;",
    "uniform float uBreath;",
    "uniform float uLine;",
    "uniform float uLineV;",
    "uniform float uLineH;",
    "uniform float uSpot;",
    "#endif",
    "uniform vec3 uPhosphor;",
    "uniform vec3 uAmbient;",
    "uniform vec3 uAmbientDir;",
    "uniform float uRoomLevel;",
    "varying vec2 vP;",
    "varying vec3 vWN;",
    "varying vec3 vWP;",
    RASTER_GLSL,
    "const vec2 RES = vec2(" + f(width, 1) + "," + f(height, 1) + ");",
    // How brightly the phosphor at a point of the signal is glowing. On the
    // desk set that is a stored (fast, slow) phosphor state; on the wall it
    // is the signal itself, times how hard that set's beam is driven.
    "#ifdef WALL",
    "float sigLod(vec2 uv, float lod){ return textureLod(uSig, vec3(uv, floor(vLayer + 0.5)), lod).r * vBeam.x; }",
    "float sigAuto(vec2 uv){ return texture(uSig, vec3(uv, floor(vLayer + 0.5))).r * vBeam.x; }",
    "#else",
    "float glow(vec2 rg){ return 0.9*rg.r + 0.1*rg.g; }",
    "float sigLod(vec2 uv, float lod){ return glow(textureLod(uSig, uv, lod).rg); }",
    "float sigAuto(vec2 uv){ return glow(texture2D(uSig, uv).rg); }",
    "#endif",
    // One scanline, sampled at its centre. The video amplifier has finite
    // bandwidth, so a dot doesn't switch on and off instantly as the beam
    // sweeps left to right: strokes smear slightly along the scan direction,
    // and only that direction, hence the lopsided taps.
    "float scanRow(float u, float lineCentre){",
    "  float v = lineCentre / RES.y;",
    "  float dx = 1.0 / RES.x;",
    "  return 0.58*sigLod(vec2(u, v), 0.0)",
    "       + 0.30*sigLod(vec2(u - 0.7*dx, v), 0.0)",
    "       + 0.12*sigLod(vec2(u - 1.5*dx, v), 0.0);",
    "}",
    "float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }",
    "float noise(vec2 p){",
    "  vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0 - 2.0*f);",
    "  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),",
    "             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);",
    "}",
    // The room as seen in the glass. Until the office is modelled and its
    // reflection baked, this is a stand-in: a dim room that is a little
    // lighter overhead, with one long ceiling light in it.
    "vec3 room(vec3 r){",
    "  vec2 d = r.xy / max(r.z, 0.15);",
    "  vec3 base = vec3(0.020, 0.022, 0.026) * (1.0 + 0.6 * clamp(d.y, -1.0, 1.0));",
    "  float strip = smoothstep(0.22, 0.05, abs(d.y - 0.95)) * smoothstep(1.5, 0.9, abs(d.x));",
    "  return (base + vec3(0.55, 0.53, 0.48) * strip) * uRoomLevel;",
    "}",
    "void main(){",
    "#ifdef WALL",
    "  float kBreath = vBeam.y; float kLine = vLine.x; float kLineV = vLine.y; float kLineH = vLine.z; float kSpot = vLine.w;",
    "#else",
    "  float kBreath = uBreath; float kLine = uLine; float kLineV = uLineV; float kLineH = uLineH; float kSpot = uSpot;",
    "#endif",
    "  vec3 N = normalize(vWN);",
    "  vec3 V = normalize(cameraPosition - vWP);",
    // The picture is on the INSIDE of the glass. Looking at an angle, the
    // phosphor you see through a given point of the surface is displaced,
    // so image and reflection slide against each other as the eye moves.
    "  vec2 p = vP - V.xy / max(V.z, 0.3) * " + f(GLASS_DEPTH) + " / vec2(" + f(FACE_HALF_W) + "," + f(FACE_HALF_H) + ");",
    "  vec2 uv = faceToRaster(p, kBreath);",
    "  vec2 e = vec2(0.0015, 0.003);",
    "  float inside = smoothstep(-e.x, e.x, uv.x) * smoothstep(-e.x, e.x, 1.0 - uv.x)",
    "               * smoothstep(-e.y, e.y, uv.y) * smoothstep(-e.y, e.y, 1.0 - uv.y);",
    "  float linesPerPx = fwidth(uv.y * RES.y);",
    // Beam profile. Each scanline is a Gaussian stripe. The structure is
    // only resolved when a line covers a few device pixels - below that it
    // would just alias, so it fades to the plain filtered picture.
    "  float ry = uv.y * RES.y;",
    "  float line0 = floor(ry);",
    "  float beam = 0.0;",
    "  for (int i = -1; i <= 1; i++) {",
    "    float centre = line0 + float(i) + 0.5;",
    "    float d = ry - centre;",
    "    beam += scanRow(uv.x, centre) * exp(-d*d / 0.30);",
    "  }",
    "  float plain = sigAuto(uv);",
    "  float pic = mix(plain, beam, 1.0 - smoothstep(1.0/3.0, 1.0/1.6, linesPerPx)) * inside;",
    // Halation: light scattering sideways inside the faceplate glass gives
    // every lit stroke a soft halo about a character wide, plus a faint
    // veil over the whole face that rises with how much of it is lit. The
    // blur comes from the signal's mip levels, picked by raster width so the
    // halo is the same size on the glass whatever the resolution.
    "  vec2 huv = clamp(uv, 0.0, 1.0);",
    "  float spill = exp(-distance(uv, huv) * 28.0);",
    "  float lodA = log2(RES.x / 90.0);",
    "  float halo = (0.10*sigLod(huv, lodA) + 0.035*sigLod(huv, lodA + 3.5)) * spill;",
    "  float em = pic + halo;",
    // Power-off: the collapsing line, then the spot, drawn in face space on
    // top of whatever the phosphor is still giving off.
    "  vec2 q = (p - vec2(" + f(RASTER.offsetX, 4) + "," + f(RASTER.offsetY, 4) + ")) / vec2(" + f(RASTER.scaleX) + "," + f(RASTER.scaleY) + ");",
    "  if (kLine > 0.0) {",
    "    float sv = max(kLineV, 0.004);",
    "    float ends = 1.0 - smoothstep(kLineH * 0.92, kLineH, abs(q.x));",
    "    em += kLine * ends * (exp(-q.y*q.y / (2.0*sv*sv)) + 0.22*exp(-q.y*q.y / (2.0*36.0*sv*sv)));",
    "  }",
    "  if (kSpot > 0.0) {",
    "    float r2 = q.x*q.x*1.78 + q.y*q.y;",
    "    em += kSpot * (exp(-r2 / 0.0002) + 0.16*exp(-r2 / 0.006));",
    "  }",
    // The phosphor coating is a pale powder. Seen through the tinted
    // faceplate twice it is a dull grey, and that - not black - is the
    // darkest the screen can be: emitted light only ever adds to it. The
    // bezel lip shades its edges.
    "  vec2 edge = vec2(1.0) - abs(vP);",
    "  float lip = smoothstep(0.0, 0.10, min(edge.x * " + f(FACE_HALF_W / FACE_HALF_H) + ", edge.y));",
    "  vec3 amb = uAmbient * (0.55 + 0.45*max(dot(N, uAmbientDir), 0.0)) * mix(0.35, 1.0, lip);",
    "  float T = " + f(GLASS_T, 2) + ";",
    "  float dust = noise(vP * 90.0) * noise(vP * 11.0 + 3.0);",
    "  vec3 col = T*T * vec3(0.68, 0.72, 0.66) * amb;",
    "  col += T * uPhosphor * em * " + f(EMISSION_GAIN, 2) + ";",
    // Outer glass surface: Fresnel reflection of the room. Unaffected by
    // anything the tube is doing, so it stays when the set is off.
    "  float F = 0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0);",
    "  col += F * room(reflect(-V, N)) * mix(0.55, 1.0, lip);",
    "  col += vec3(0.010) * dust * amb;",
    "  gl_FragColor = vec4(col, 1.0);",
    "  #include <colorspace_fragment>",
    "}",
  ].join("\n");
}

// options: { wall: true for the instanced form, width, height: the signal's
// size in dots, phosphor: [r, g, b] }
export function createFaceMaterial(options) {
  var uniforms = {
    uSig: { value: null },
    uPhosphor: { value: new Vector3().fromArray(options.phosphor || PHOSPHORS.green) },
    uAmbient: { value: new Color(0.05, 0.052, 0.056) },
    uAmbientDir: { value: new Vector3(0, 0.6, 0.8).normalize() },
    uRoomLevel: { value: 1 },
  };
  if (!options.wall) {
    uniforms.uBreath = { value: 1 };
    uniforms.uLine = { value: 0 };
    uniforms.uLineV = { value: 1 };
    uniforms.uLineH = { value: 1 };
    uniforms.uSpot = { value: 0 };
  }
  return new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: fragment(options.width, options.height),
    uniforms: uniforms,
    defines: options.wall ? { WALL: "" } : {},
  });
}

// The glass: a section of a sphere, larger than the bezel opening so its
// edges are hidden behind the lip.
export function createFaceGeometry(segmentsX, segmentsY) {
  var geo = new PlaneGeometry(FACE_HALF_W * 2 + 0.5, FACE_HALF_H * 2 + 0.5, segmentsX || 64, segmentsY || 48);
  var pos = geo.attributes.position;
  for (var i = 0; i < pos.count; i++) {
    var x = pos.getX(i);
    var y = pos.getY(i);
    pos.setZ(i, Math.sqrt(FACE_RADIUS * FACE_RADIUS - x * x - y * y) - FACE_RADIUS + FACE_APEX_Z);
  }
  geo.computeVertexNormals();
  return geo;
}

// Where on the raster a ray lands, for a hit at (x, y) on the face in the
// set's own space with the ray going in local direction (dx, dy, dz). The
// same glass-depth correction as the shader, so a click lands on the
// character that is actually drawn under the pointer. Returns null on the
// bezel side of the opening.
export function faceHit(x, y, dx, dy, dz) {
  if (Math.abs(x) > FACE_HALF_W || Math.abs(y) > FACE_HALF_H) return null;
  var k = GLASS_DEPTH / Math.max(-dz, 0.3);
  return { px: (x + dx * k) / FACE_HALF_W, py: (y + dy * k) / FACE_HALF_H };
}
