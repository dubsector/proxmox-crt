// One full-quality tube: the desk terminal. A 720 x 350 video signal goes
// in; a phosphor-state texture is kept from it, frame by frame, and the face
// shader draws that. (The wall's many small sets take a cheaper road, see
// wall.js.)
import {
  Scene,
  OrthographicCamera,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  DataTexture,
  WebGLRenderTarget,
  RedFormat,
  RGBAFormat,
  UnsignedByteType,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  ClampToEdgeWrapping,
} from "three";
import { RASTER } from "./raster.js";
import { createFaceMaterial, createFaceGeometry } from "./face.js";
import { createPower, setPower, snapPower, stepPower } from "./power.js";

// Phosphor decay. P39 is long-persistence: most of the light is gone within
// a few frames but a faint tail hangs on for the best part of a second,
// which is what leaves ghosts behind changing text. It is not a single
// exponential, so it's modelled as a fast and a slow component.
var DECAY_FAST_S = 0.045;
export var DECAY_SLOW_S = 0.7;
// The collapsing line at switch-off, in units of mean picture level per
// unit of line brightness: all the beam current, on a sliver of the face.
var COLLAPSE_LINE_LIGHT = 0.06 / 14;

var PERSIST_VERT = "void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }";

// Phosphor state update, run at signal resolution. Wherever the beam is
// lighting a dot the phosphor is driven to that level; everywhere else it
// decays by however much real time has passed, so the trails look the same
// on a 60 Hz and a 144 Hz display.
var PERSIST_FRAG = [
  "uniform sampler2D uPrev;",
  "uniform sampler2D uSignal;",
  "uniform float uKeepFast;",
  "uniform float uKeepSlow;",
  "uniform float uGain;",
  "void main(){",
  "  vec2 uv = gl_FragCoord.xy / vec2(" + RASTER.width.toFixed(1) + "," + RASTER.height.toFixed(1) + ");",
  "  vec2 prev = texture2D(uPrev, uv).rg;",
  "  float s = texture2D(uSignal, uv).r * uGain;",
  "  vec2 next = max(vec2(s), prev * vec2(uKeepFast, uKeepSlow));",
  "  gl_FragColor = vec4(step(0.002, next) * next, 0.0, 1.0);",
  "}",
].join("\n");

export function createTube(renderer, options) {
  var opts = options || {};
  var W = RASTER.width;
  var H = RASTER.height;
  // The video signal: one byte per dot, first row at the top. Whoever owns
  // the picture writes into this and calls changed().
  var signal = new Uint8Array(W * H);
  var signalTex = new DataTexture(signal, W, H, RedFormat, UnsignedByteType);
  signalTex.minFilter = LinearFilter;
  signalTex.magFilter = LinearFilter;
  signalTex.wrapS = signalTex.wrapT = ClampToEdgeWrapping;
  signalTex.needsUpdate = true;

  function makeTarget() {
    // Half-float so a slow decay can't stall on 8-bit rounding and leave a
    // permanent ghost. Mipmaps give the halation blur for free.
    return new WebGLRenderTarget(W, H, {
      format: RGBAFormat,
      type: HalfFloatType,
      minFilter: LinearMipmapLinearFilter,
      magFilter: LinearFilter,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      generateMipmaps: true,
      depthBuffer: false,
    });
  }
  var targetA = makeTarget();
  var targetB = makeTarget();

  var persistMat = new ShaderMaterial({
    vertexShader: PERSIST_VERT,
    fragmentShader: PERSIST_FRAG,
    uniforms: {
      uPrev: { value: null },
      uSignal: { value: signalTex },
      uKeepFast: { value: 0 },
      uKeepSlow: { value: 0 },
      uGain: { value: 1 },
    },
    depthTest: false,
    depthWrite: false,
  });
  var persistScene = new Scene();
  var persistQuad = new Mesh(new PlaneGeometry(2, 2), persistMat);
  persistQuad.frustumCulled = false;
  persistScene.add(persistQuad);
  var persistCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  var material = createFaceMaterial({ width: W, height: H, phosphor: opts.phosphor });
  material.uniforms.uSig.value = targetA.texture;
  var geometry = createFaceGeometry(64, 48);
  var mesh = new Mesh(geometry, material);

  var power = createPower(false);
  var apl = 0;

  var tube = {
    mesh: mesh,
    material: material,
    signal: signal,
    width: W,
    height: H,
    power: power,
    // The picture changed; `level` is its average picture level (0-1).
    changed: function (level) {
      apl = level;
      signalTex.needsUpdate = true;
    },
    setPower: function (on, instant) {
      if (instant) snapPower(power, on);
      else setPower(power, on);
    },
    // How much light the tube is throwing on its surroundings right now.
    light: function () {
      return apl * power.gain + COLLAPSE_LINE_LIGHT * power.line;
    },
    // Runs the phosphor pass. Returns true while the power state is moving.
    update: function (dt) {
      var moving = stepPower(power, dt, apl);
      var u = material.uniforms;
      u.uBreath.value = power.breath;
      u.uLine.value = power.line;
      u.uLineV.value = power.lineV;
      u.uLineH.value = power.lineH;
      u.uSpot.value = power.spot;

      persistMat.uniforms.uPrev.value = targetA.texture;
      persistMat.uniforms.uKeepFast.value = Math.exp(-dt / DECAY_FAST_S);
      persistMat.uniforms.uKeepSlow.value = Math.exp(-dt / DECAY_SLOW_S);
      persistMat.uniforms.uGain.value = power.gain;
      renderer.setRenderTarget(targetB);
      renderer.render(persistScene, persistCam);
      renderer.setRenderTarget(null);
      var swap = targetA;
      targetA = targetB;
      targetB = swap;
      u.uSig.value = targetA.texture;
      return moving;
    },
    dispose: function () {
      targetA.dispose();
      targetB.dispose();
      signalTex.dispose();
      persistQuad.geometry.dispose();
      persistMat.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
  return tube;
}
