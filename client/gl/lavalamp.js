// A lava lamp on the desk: somebody's own, among the issue equipment.
//
// The glass is drawn by one shader that looks into it: the ray from the eye
// bends where it enters the glass, crosses the lit liquid, and stops on the
// wax, which is a handful of soft blobs and the pool at the bottom melted
// into one surface (a distance field), so blobs that meet run together and
// blobs that part pull a neck between them. The bulb in the base lights it
// all from below: wax glows through where it is thin, the liquid glows most
// near the bottom, and the glass carries the room's highlights on top. How
// the wax moves is gl/lavawax.js.
//
// It lights the desk around it: a three.js light for the plain room's
// parts, and in the baked office (which three's lights do not reach) a pool
// of its colour laid on the desk top, with the shadow of its own base.
import {
  Group,
  Mesh,
  CylinderGeometry,
  PlaneGeometry,
  LatheGeometry,
  Vector2,
  ShaderMaterial,
  PointLight,
  Color,
  Vector3,
  Vector4,
  Matrix4,
  AdditiveBlending,
  CustomBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  AddEquation,
} from "three";
import { createWax, stepWax, pooled } from "./lavawax.js";

var LAMP = {
  baseH: 1.0,
  glassH: 2.4,
  capH: 0.45,
  glassLow: 0.52,
  glassHigh: 0.24,
  // How thick the glass is.
  wall: 0.025,
  blobs: 9,
  // How far up the glass the liquid comes; air above it.
  fill: 0.93,
};

// Linear colours. The wax is the classic orange; the liquid a deep violet
// that the bulb turns warm near the bottom.
var WAX = new Color(1.0, 0.3, 0.035);
var WAX_DEEP = new Color(0.5, 0.05, 0.015);
var LIQUID = new Color(0.5, 0.06, 0.32);
// What the liquid takes out of light going through it, per unit.
var ABSORB = new Vector3(0.7, 2.4, 1.1);
// The colour it throws on the desk: wax and liquid together.
var THROWN = new Color(1.0, 0.36, 0.22);

var GLASS_VERTEX = [
  "varying vec3 vLocal;",
  "void main() {",
  "  vLocal = position;",
  "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
  "}",
].join("\n");

var GLASS_FRAGMENT = [
  "#define BLOBS " + LAMP.blobs,
  "uniform vec3 uCam;",
  "uniform vec4 uBlobs[BLOBS];",
  "uniform float uStretch[BLOBS];",
  "uniform vec3 uPool;", // y of its centre, radius, height
  "uniform float uY0, uH, uRLow, uRHigh, uWall, uTop;",
  "uniform float uLevel, uHeat, uRoom, uTime;",
  "uniform vec3 uWax, uWaxDeep, uLiquid, uAbsorb, uScreen, uScreenDir;",
  "varying vec3 vLocal;",
  "",
  "float coneR(float y) { return mix(uRLow, uRHigh, clamp((y - uY0) / uH, 0.0, 1.0)); }",
  "// Inside the glass: negative in the liquid.",
  "float sdInside(vec3 p) {",
  "  float k = (uRLow - uRHigh) / uH;",
  "  float d = (length(p.xz) - coneR(p.y) + uWall) * inversesqrt(1.0 + k * k);",
  "  return max(d, max(uY0 + 0.02 - p.y, p.y - (uY0 + uH - 0.02)));",
  "}",
  "float sdEll(vec3 p, vec3 r) {",
  "  float k0 = length(p / r);",
  "  float k1 = length(p / (r * r));",
  "  return k0 * (k0 - 1.0) / k1;",
  "}",
  "float smin(float a, float b, float k) {",
  "  float h = max(k - abs(a - b), 0.0) / k;",
  "  return min(a, b) - h * h * h * k / 6.0;",
  "}",
  "float sdWax(vec3 p) {",
  "  // Wax is never quite round: a slow, soft warp of its surface.",
  "  vec3 w = p;",
  "  w.x += 0.028 * sin(p.y * 5.3 + uTime * 0.31 + p.z * 2.1);",
  "  w.z += 0.028 * sin(p.y * 4.7 - uTime * 0.27 + p.x * 2.3 + 1.7);",
  "  w.y += 0.022 * sin(p.x * 6.1 + p.z * 4.3 + uTime * 0.23);",
  "  p = w;",
  "  vec3 q = p - vec3(0.0, uPool.x, 0.0);",
  "  float d = sdEll(q, vec3(uPool.y, uPool.z, uPool.y));",
  "  for (int i = 0; i < BLOBS; i++) {",
  "    vec4 b = uBlobs[i];",
  "    float s = uStretch[i];",
  "    vec3 r = b.w * vec3(inversesqrt(s), s, inversesqrt(s));",
  "    d = smin(d, sdEll(p - b.xyz, r), 0.2);",
  "  }",
  "  // Wax that meets the glass flattens on it.",
  "  return max(max(d, sdInside(p) + 0.004), p.y - uTop + 0.004);",
  "}",
  "vec3 waxNormal(vec3 p) {",
  "  const vec2 e = vec2(0.004, -0.004);",
  "  return normalize(e.xyy * sdWax(p + e.xyy) + e.yyx * sdWax(p + e.yyx) + e.yxy * sdWax(p + e.yxy) + e.xxx * sdWax(p + e.xxx));",
  "}",
  "// The bulb, under the glass, throwing its light up into it.",
  "// The liquid scatters it near the bulb; the wax, held in the beam, keeps",
  "// more of it further up.",
  "float bulb(vec3 p) {",
  "  vec3 d = p - vec3(0.0, uY0 - 0.22, 0.0);",
  "  float r2 = dot(d, d);",
  "  float up = smoothstep(-0.1, 1.0, d.y * inversesqrt(r2));",
  "  return up / (0.18 + 1.5 * r2);",
  "}",
  "float beam(vec3 p) {",
  "  vec3 d = p - vec3(0.0, uY0 - 0.22, 0.0);",
  "  float r2 = dot(d, d);",
  "  float up = smoothstep(-0.4, 1.0, d.y * inversesqrt(r2));",
  "  return up / (0.45 + 0.32 * r2);",
  "}",
  "// What the glass mirrors: the dim office. The ceiling's tubes overhead,",
  "// a broad soft light from the room behind the eye, the desk terminal's",
  "// screen off to the side.",
  "vec3 room(vec3 r) {",
  "  float az = atan(r.x, r.z);",
  "  float up = r.y;",
  "  float tubes = smoothstep(0.35, 0.75, up) * (0.6 + 0.4 * cos(az * 3.0));",
  "  float key = 2.2 * exp(-pow(az + 0.45, 2.0) / 0.004) * smoothstep(-0.5, 0.4, up) * (1.0 - smoothstep(0.6, 0.95, up));",
  "  float fill = exp(-pow(az - 0.9, 2.0) / 0.12) * smoothstep(-0.3, 0.3, up) * 0.35;",
  "  vec3 c = vec3(1.0, 0.97, 0.9) * (0.06 + uRoom * (0.9 * tubes + 1.1 * key + fill));",
  "  float scr = pow(max(dot(r, uScreenDir), 0.0), 24.0);",
  "  return c + uScreen * scr;",
  "}",
  "",
  "void main() {",
  "  vec3 rd = normalize(vLocal - uCam);",
  "  float k = (uRLow - uRHigh) / uH;",
  "  vec3 n = normalize(vec3(normalize(vLocal.xz).x, k, normalize(vLocal.xz).y));",
  "  float cosi = clamp(dot(-rd, n), 0.0, 1.0);",
  "  float fres = 0.04 + 0.96 * pow(1.0 - cosi, 5.0);",
  "  // Into the glass and the liquid behind it.",
  "  vec3 ri = refract(rd, n, 1.0 / 1.38);",
  "  vec3 p = vLocal + ri * (uWall * 1.5);",
  "  vec3 tr = vec3(1.0);",
  "  vec3 acc = vec3(0.0);",
  "  vec3 liquid = uLiquid * (0.5 * uLevel);",
  "  vec3 dim = uLiquid * (0.012 + 0.03 * uRoom);",
  "  bool hit = false;",
  "  for (int i = 0; i < 80; i++) {",
  "    float d = sdWax(p);",
  "    if (d < 0.001) { hit = true; break; }",
  "    if (i > 2 && sdInside(p) > 0.0) break;",
  "    float st = clamp(d * 0.9, 0.006, 0.09);",
  "    // The liquid glows with the bulb's light, warmer where it is strong.",
  "    // Above the liquid there is only air.",
  "    if (p.y < uTop) {",
  "      float b = bulb(p);",
  "      vec3 glow = liquid * b + dim + uWax * (0.12 * uLevel * b * b);",
  "      acc += tr * glow * st;",
  "      tr *= exp(-uAbsorb * st);",
  "    }",
  "    p += ri * st;",
  "  }",
  "  if (hit) {",
  "    vec3 nw = waxNormal(p);",
  "    float b = beam(p);",
  "    vec3 tl = normalize(vec3(0.0, uY0 - 0.22, 0.0) - p);",
  "    float facing = clamp(dot(nw, tl) * 0.5 + 0.5, 0.0, 1.0);",
  "    facing *= facing;",
  "    // How thin the wax is just behind its surface: light comes through",
  "    // the thin edges and necks.",
  "    float depth = clamp(-sdWax(p - nw * 0.09) / 0.09, 0.0, 1.0);",
  "    float thin = 1.0 - depth;",
  "    float hy = clamp((p.y - uY0) / uH, 0.0, 1.0);",
  "    vec3 col = mix(uWaxDeep, uWax, 0.35 + 0.65 * facing);",
  "    vec3 lit = col * b * uLevel * (0.3 + 1.4 * facing + 1.2 * thin);",
  "    // Lit from inside, through the wax itself, strongest low down.",
  "    lit += uWax * uLevel * thin * 0.3 * (1.0 - 0.5 * hy);",
  "    // What the room gives it, dimly, from above.",
  "    lit += col * (0.015 + 0.06 * uRoom) * (0.5 + 0.5 * nw.y);",
  "    // Seen edge-on its rim takes the liquid's colour.",
  "    float rim = pow(1.0 - clamp(dot(nw, -ri), 0.0, 1.0), 3.0);",
  "    lit = mix(lit, lit * 0.6 + uLiquid * uLevel * b * 0.3, rim * 0.5);",
  "    // A soft sheen where the room lights catch its wet surface.",
  "    vec3 hr = reflect(ri, nw);",
  "    lit += room(hr) * 0.04 * pow(rim, 0.5);",
  "    acc += tr * lit;",
  "    tr = vec3(0.0);",
  "  }",
  "  // Hot wax and the liquid by the bulb burn toward yellow, as they do on film.",
  "  acc = 1.0 - exp(-acc * 1.25);",
  "  vec3 refl = room(reflect(rd, n));",
  "  // Light running round inside the glass wall shows at the edges.",
  "  float edge = pow(1.0 - cosi, 3.0);",
  "  float through = (tr.r + tr.g + tr.b) / 3.0;",
  "  vec3 col = acc * (1.0 - fres) + refl * fres + uLiquid * uLevel * edge * 0.08;",
  "  // The liquid's surface: a bright line where it climbs the glass.",
  "  float line = exp(-pow((vLocal.y - uTop) / 0.007, 2.0));",
  "  col += (uLiquid * uLevel * 0.25 + vec3(0.9, 0.88, 0.85) * (0.03 + 0.25 * uRoom)) * line * (0.35 + edge);",
  "  through *= 1.0 - 0.35 * line;",
  "  // Thick glass darkens toward its edges.",
  "  through *= 1.0 - 0.5 * edge;",
  "  float alpha = 1.0 - through * (1.0 - fres);",
  "  gl_FragColor = vec4(col, alpha);",
  "  #include <colorspace_fragment>",
  "}",
].join("\n");

// The metal, as [radius, height] from the axis at the desk up to the axis
// at the glass: a foot with a small lip, in to the waist, out to the rim the
// glass stands in. And the cap, from its rim on the glass up to its top.
var BASE_PROFILE = [
  [0, 0],
  [0.6, 0],
  [0.625, 0.022],
  [0.615, 0.05],
  [0.3, 0.6],
  [0.3, 0.63],
  [0.56, 0.975],
  [0.565, 1.0],
  [0.5, 1.0],
  [0.5, 1.02],
  [0, 1.02],
];
var CAP_PROFILE = [
  [0, -0.01],
  [0.27, -0.01],
  [0.272, 0.03],
  [0.135, 0.41],
  [0.1, 0.445],
  [0, 0.455],
];
// Brushed aluminium, a little warm.
var METAL = new Color(0.86, 0.83, 0.78);

// The outline with its corners rounded off by about r, for the lathe: a
// spun part has no knife edges, and the light runs round its fillets.
function rounded(points, r) {
  var out = [new Vector2(points[0][0], points[0][1])];
  for (var i = 1; i < points.length - 1; i++) {
    var a = points[i - 1];
    var p = points[i];
    var b = points[i + 1];
    var la = Math.hypot(a[0] - p[0], a[1] - p[1]);
    var lb = Math.hypot(b[0] - p[0], b[1] - p[1]);
    var ra = Math.min(r, la / 2) / la;
    var rb = Math.min(r, lb / 2) / lb;
    var s0 = [p[0] + (a[0] - p[0]) * ra, p[1] + (a[1] - p[1]) * ra];
    var s1 = [p[0] + (b[0] - p[0]) * rb, p[1] + (b[1] - p[1]) * rb];
    for (var k = 0; k <= 4; k++) {
      var t = k / 4;
      var x = (1 - t) * (1 - t) * s0[0] + 2 * (1 - t) * t * p[0] + t * t * s1[0];
      var y = (1 - t) * (1 - t) * s0[1] + 2 * (1 - t) * t * p[1] + t * t * s1[1];
      out.push(new Vector2(Math.max(0, x), y));
    }
  }
  var last = points[points.length - 1];
  out.push(new Vector2(last[0], last[1]));
  return out;
}

var METAL_VERTEX = [
  "varying vec3 vLocal;",
  "varying vec3 vN;",
  "void main() {",
  "  vLocal = position;",
  "  vN = normal;",
  "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
  "}",
].join("\n");

var METAL_FRAGMENT = [
  "uniform vec3 uCam, uTint, uThrown, uScreen, uScreenDir;",
  "uniform float uY0, uH, uLevel, uRoom;",
  "varying vec3 vLocal;",
  "varying vec3 vN;",
  "float hash(float x) { return fract(sin(x * 127.1) * 43758.5453); }",
  "float noise(float x) { float i = floor(x); float f = fract(x); return mix(hash(i), hash(i + 1.0), f * f * (3.0 - 2.0 * f)); }",
  "// The room as the metal sees it, blurred by how rough it is: the desk",
  "// below, warm where the lamp lights it; the dark panels around; the",
  "// ceiling's tubes above; a soft light from the room behind the eye.",
  "vec3 env(vec3 r, float rough) {",
  "  float up = r.y;",
  "  float az = atan(r.x, r.z);",
  "  float w = 0.25 + rough;",
  "  vec3 desk = vec3(0.32, 0.2, 0.12) * (0.03 + 0.3 * uRoom) + uThrown * uLevel * 0.07;",
  "  vec3 wall = vec3(0.045, 0.055, 0.075) * (0.25 + uRoom);",
  "  vec3 ceil = vec3(1.0, 0.97, 0.9) * (0.02 + uRoom * 0.55 * (0.6 + 0.4 * cos(az * 3.0)));",
  "  vec3 c = mix(desk, wall, smoothstep(-0.2 - w * 0.3, 0.05 + w * 0.3, up));",
  "  c = mix(c, ceil, smoothstep(0.25 - w * 0.4, 0.75 + w * 0.2, up));",
  "  float key = exp(-pow(az + 0.45, 2.0) / (0.01 + w * w * 0.3)) * smoothstep(-0.6, 0.3, up) * (1.0 - smoothstep(0.6, 0.95, up));",
  "  c += vec3(1.0, 0.97, 0.9) * key * uRoom * (0.7 / (1.0 + 6.0 * rough));",
  "  c += uScreen * pow(max(dot(r, uScreenDir), 0.0), 6.0 / (0.2 + rough));",
  "  return c;",
  "}",
  "void main() {",
  "  vec3 p = vLocal;",
  "  vec3 n = normalize(vN);",
  "  vec3 v = normalize(uCam - p);",
  "  float rad = length(p.xz);",
  "  // Turned on a lathe: rings, finer and coarser, in how rough it is.",
  "  float rings = noise(p.y * 260.0) * 0.6 + noise(p.y * 41.0) * 0.4;",
  "  float rough = 0.22 + 0.12 * rings;",
  "  // The rubber foot on the desk.",
  "  bool foot = p.y < 0.018 && rad > 0.3;",
  "  vec3 r = reflect(-v, n);",
  "  float cosv = clamp(dot(n, v), 0.0, 1.0);",
  "  vec3 f0 = uTint * (0.92 + 0.08 * rings);",
  "  vec3 fres = f0 + (1.0 - f0) * pow(1.0 - cosv, 5.0);",
  "  vec3 col = env(r, rough) * fres;",
  "  // The glass above, a tall light brightest low down, lights the",
  "  // shoulders of the base and the inside of the cap. Brushed round,",
  "  // its highlights run up and down the metal.",
  "  vec3 q = vec3(0.0, clamp(p.y, uY0 + 0.12, uY0 + uH - 0.1), 0.0);",
  "  vec3 tl = q - p;",
  "  float d2 = dot(tl, tl);",
  "  tl *= inversesqrt(d2);",
  "  float bright = mix(1.0, 0.3, clamp((q.y - uY0) / uH, 0.0, 1.0));",
  "  vec3 lamp = uThrown * uLevel * bright * 1.6 / (0.15 + d2);",
  "  vec3 t = normalize(vec3(-p.z, 0.0, p.x) + 1e-5);",
  "  vec3 h = normalize(tl + v);",
  "  float th = dot(t, h);",
  "  float aniso = pow(sqrt(max(0.0, 1.0 - th * th)), 90.0);",
  "  float ndl = max(dot(n, tl), 0.0);",
  "  col += lamp * fres * (aniso * 1.4 + 0.18) * ndl;",
  "  // Shadowed where it meets the desk and in under the waist.",
  "  float ao = mix(0.45, 1.0, smoothstep(0.0, 0.25, p.y));",
  "  ao *= mix(1.0, 0.75, (1.0 - smoothstep(0.0, 0.18, abs(p.y - 0.6))) * step(p.y, uY0));",
  "  col *= ao;",
  "  if (foot) col = vec3(0.012, 0.011, 0.01) * (0.4 + uRoom) + lamp * 0.02;",
  "  col = 1.0 - exp(-col * 1.15);",
  "  gl_FragColor = vec4(col, 1.0);",
  "  #include <colorspace_fragment>",
  "}",
].join("\n");

// The lamp's light on the desk top, for the baked office: as from the glass
// (a line of light from bottom to top, brightest low down), falling off with
// distance and slant, and cut where the top of the base hides the glass.
var DESK_VERTEX = [
  "varying vec2 vXZ;",
  "void main() {",
  "  vXZ = vec2(position.x, -position.y);",
  "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
  "}",
].join("\n");

var DESK_FRAGMENT = [
  "uniform vec3 uColor;",
  "uniform float uLevel, uY0, uH, uRim, uBack, uReach;",
  "varying vec2 vXZ;",
  "void main() {",
  "  float r = length(vXZ);",
  "  float e = 0.0;",
  "  for (int i = 0; i < 4; i++) {",
  "    float f = (float(i) + 0.5) / 4.0;",
  "    float h = uY0 + uH * f * 0.8;",
  "    float w = 1.0 - 0.7 * f;",
  "    float d2 = r * r + h * h;",
  "    // The base's rim, uRim out at its top, shades the desk close by.",
  "    float edge = uRim * h / (h - uY0 + 0.001);",
  "    float lit = smoothstep(edge - 0.35, edge + 0.5, r);",
  "    e += w * lit * h / (d2 * sqrt(d2));",
  "  }",
  "  e *= 1.0 - smoothstep(uReach * 0.6, uReach, r);",
  "  // Not past the back of the desk.",
  "  e *= smoothstep(uBack - 0.05, uBack + 0.3, vXZ.y);",
  "  gl_FragColor = vec4(uColor * (e * uLevel), 1.0);",
  "  #include <colorspace_fragment>",
  "}",
].join("\n");

// options: { x, y: the desk top, z, still: no movement (reduced motion),
// back: the z of the desk's back edge }
export function createLavaLamp(options) {
  var L = LAMP;
  var group = new Group();
  group.position.set(options.x, options.y, options.z);
  var owned = [];
  var y0 = L.baseH;


  var solid = [];
  function add(geometry, material, y) {
    var m = new Mesh(geometry, material);
    m.position.y = y;
    owned.push(geometry);
    group.add(m);
    solid.push(m);
    return m;
  }


  // --- the glass, and what is in it ----------------------------------------
  var wax = createWax(L.blobs, 11);
  // The last two are the small beads that break off the big ones.
  wax.blobs[L.blobs - 1].size = 0.06;
  wax.blobs[L.blobs - 2].size = 0.075;
  var blobUniforms = [];
  var stretchUniforms = [];
  for (var b = 0; b < L.blobs; b++) {
    blobUniforms.push(new Vector4(0, y0, 0, 0.1));
    stretchUniforms.push(1);
  }
  var u = {
    uCam: { value: new Vector3() },
    uBlobs: { value: blobUniforms },
    uStretch: { value: stretchUniforms },
    uPool: { value: new Vector3(y0, L.glassLow, 0.12) },
    uY0: { value: y0 },
    uH: { value: L.glassH },
    uRLow: { value: L.glassLow },
    uRHigh: { value: L.glassHigh },
    uWall: { value: L.wall },
    uTop: { value: L.baseH + L.glassH * L.fill },
    uLevel: { value: 1 },
    uHeat: { value: 1 },
    uRoom: { value: 0.6 },
    uTime: { value: 0 },
    uWax: { value: WAX.clone() },
    uWaxDeep: { value: WAX_DEEP.clone() },
    uLiquid: { value: LIQUID.clone() },
    uAbsorb: { value: ABSORB.clone() },
    uScreen: { value: new Color(0, 0, 0) },
    // Toward the desk terminal, which sits at the origin.
    uScreenDir: { value: new Vector3(-options.x, -options.y - y0 - L.glassH / 2, -options.z).normalize() },
  };
  var glassMat = new ShaderMaterial({
    uniforms: u,
    vertexShader: GLASS_VERTEX,
    fragmentShader: GLASS_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
  });
  owned.push(glassMat);
  // The base and the cap: spun and brushed aluminium, drawn here in the
  // baked office too, since a light map cannot show metal. It mirrors the
  // dim room and the desk, and the glass above lights its shoulders.
  var metal = new ShaderMaterial({
    uniforms: Object.assign({}, u, { uTint: { value: METAL.clone() }, uThrown: { value: THROWN.clone() } }),
    vertexShader: METAL_VERTEX,
    fragmentShader: METAL_FRAGMENT,
  });
  owned.push(metal);
  // The base narrows to a waist and widens again to hold the glass; the
  // cap rounds over at the top. The same outline as the bake's.
  var baseGeometry = new LatheGeometry(rounded(BASE_PROFILE, 0.018), 96);
  var capGeometry = new LatheGeometry(rounded(CAP_PROFILE.map(function (q) {
    return [q[0], q[1] + y0 + L.glassH];
  }), 0.02), 96);
  add(baseGeometry, metal, 0);
  add(capGeometry, metal, 0);

  // In the group's own space, so the shader can work there.
  var glassGeometry = new CylinderGeometry(L.glassHigh, L.glassLow, L.glassH, 64, 1, true);
  glassGeometry.translate(0, y0 + L.glassH / 2, 0);
  var glass = add(glassGeometry, glassMat, 0);
  glass.renderOrder = 1;
  var toLocal = new Matrix4();
  glass.onBeforeRender = function (renderer, scene, camera) {
    toLocal.copy(group.matrixWorld).invert();
    u.uCam.value.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(toLocal);
  };

  // Its light on the plain room's parts.
  var light = new PointLight(new Color(1.0, 0.36, 0.28), 2.2, 9, 1.6);
  light.position.y = L.baseH + L.glassH * 0.4;
  group.add(light);

  // The desk glow, used in the baked office only.
  var REACH = 6;
  var deskUniforms = {
    uColor: { value: new Color().copy(THROWN).multiplyScalar(0.75) },
    uLevel: { value: 1 },
    uY0: { value: y0 },
    uH: { value: L.glassH },
    uRim: { value: L.glassLow + 0.04 },
    uBack: { value: (options.back === undefined ? -1e3 : options.back) - options.z },
    uReach: { value: REACH },
  };
  var deskMat = new ShaderMaterial({
    uniforms: deskUniforms,
    vertexShader: DESK_VERTEX,
    fragmentShader: DESK_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
  });
  var deskGeometry = new PlaneGeometry(REACH * 2, REACH * 2);
  var deskGlow = new Mesh(deskGeometry, deskMat);
  deskGlow.rotation.x = -Math.PI / 2;
  deskGlow.position.y = 0.012;
  deskGlow.visible = false;
  group.add(deskGlow);
  owned.push(deskMat, deskGeometry);

  // Where a blob may go, as heights of the glass: resting on the pool, or
  // up under the cap.
  function poolHeight() {
    return 0.1 + 0.2 * pooled(wax);
  }
  function floorOf(blob) {
    return (poolHeight() * 0.55 + blob.size * 0.55) / L.glassH;
  }
  function ceilingOf(blob) {
    return L.fill - (blob.size * 1.15 + 0.03) / L.glassH;
  }

  // Hands the wax's state to the shader.
  function place() {
    var ph = poolHeight();
    var t = wax.time;
    u.uPool.value.set(y0, L.glassLow * 1.05, ph + 0.012 * Math.sin(t * 0.3));
    wax.blobs.forEach(function (blob, i) {
      var y = y0 + blob.h * L.glassH;
      var inner = L.glassLow + ((L.glassHigh - L.glassLow) * (y - y0)) / L.glassH - L.wall;
      // Off centre by as much as the glass leaves it room for.
      var out = blob.out * Math.max(0, inner - blob.size * 1.1 - 0.03);
      // Cold, it sinks into the pool and is part of it.
      var s = blob.settled;
      var size = blob.size * (1 - 0.75 * s);
      y -= s * (y - y0);
      out *= 1 - s;
      blobUniforms[i].set(Math.cos(blob.turn) * out, y, Math.sin(blob.turn) * out, size);
      stretchUniforms[i] = blob.stretch;
    });
    u.uTime.value = t;
  }

  // A real one takes an hour to get going and as long to stop; this one
  // warms through in about a minute and cools in two.
  var WARM_S = 20;
  var COOL_S = 35;
  var on = true;
  var level = 1;
  var heat = 1;
  var baked = false;
  var room = 0.6;
  // From a lamp that has been on a while.
  stepWax(wax, 240, heat, floorOf, ceilingOf);
  place();

  // Switched off, the light goes at once; the wax takes its time.
  function show() {
    u.uLevel.value = level;
    u.uHeat.value = heat;
    deskUniforms.uLevel.value = level;
    light.intensity = 2.2 * level;
  }
  show();

  return {
    group: group,
    // Nothing of it is drawn by the bake: the bake's metal is hidden.
    shell: [],
    // Moves the wax on by dt seconds. True while it is moving.
    update: function (dt) {
      var goal = on ? 1 : 0;
      var moving = false;
      if (level !== goal) {
        level = options.still || Math.abs(goal - level) < 0.003 ? goal : level + (goal - level) * (1 - Math.exp(-dt / 0.12));
        show();
        moving = true;
      }
      if (options.still) {
        if (heat !== goal) {
          heat = goal;
          // Straight to where the wax ends up.
          stepWax(wax, 240, heat, floorOf, ceilingOf);
          place();
          show();
        }
        return moving;
      }
      if (heat !== goal) heat = Math.abs(goal - heat) < 0.002 ? goal : heat + (goal - heat) * (1 - Math.exp(-dt / (on ? WARM_S : COOL_S)));
      // Cold through and dark, nothing in it moves.
      if (!heat && !on && pooled(wax) > 0.999) return moving;
      stepWax(wax, Math.min(dt, 0.25), heat, floorOf, ceilingOf);
      place();
      show();
      return true;
    },
    // What a click over the lamp lands on, and stops at.
    pickables: solid,
    setOn: function (to) {
      on = !!to;
    },
    on: function () {
      return on;
    },
    // The office's ceiling lights, 0..1 of the bake: for the highlights on
    // the glass.
    setRoom: function (level) {
      room = level;
      u.uRoom.value = baked ? Math.min(1, room * 2.4) : room;
    },
    // The desk terminal's light, for its reflection on the glass.
    setScreenLight: function (color) {
      u.uScreen.value.copy(color).multiplyScalar(0.6);
    },
    // The baked office is in: three's light no longer reaches the desk.
    useBaked: function () {
      baked = true;
      deskGlow.visible = true;
      this.setRoom(room);
    },
    dispose: function () {
      owned.forEach(function (o) {
        o.dispose();
      });
      light.dispose();
    },
  };
}
