// A bank of small monitors drawn together: every tube face in one draw
// call, every cabinet in another. Each set has its own layer of one array
// texture for its picture, and its own power state.
//
// These are the cheap relatives of the desk terminal's tube (tube.js). They
// have no phosphor-state pass: at the size a wall monitor has on screen, and
// with pictures that change every couple of seconds, afterglow is not
// something anyone can see, and leaving it out keeps fifty sets about as
// expensive as two.
import {
  InstancedMesh,
  InstancedBufferAttribute,
  BoxGeometry,
  MeshStandardMaterial,
  MeshBasicMaterial,
  DataArrayTexture,
  Color,
  RedFormat,
  UnsignedByteType,
  LinearFilter,
  LinearMipmapLinearFilter,
  ClampToEdgeWrapping,
  Matrix4,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { createFaceMaterial, createFaceGeometry, FACE_HALF_W, FACE_HALF_H } from "./face.js";
import { createPower, setPower, snapPower, stepPower } from "./power.js";

// The cabinet around the opening, in tube units: a frame in front, a box
// behind. The chin under the screen is deeper than the top, for the lamp.
export var CABINET = { halfW: 2.5, top: 2.0, bottom: -2.2, front: 0.3, seam: -0.6, back: -4.5 };

var LED_COLORS = {
  off: new Color(0.02, 0.025, 0.02),
  on: new Color(0.05, 0.5, 0.1),
  selected: new Color(1.0, 0.12, 0.05),
};

function box(x0, x1, y0, y1, z0, z1) {
  var g = new BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
}

export function createCabinetGeometry() {
  var c = CABINET;
  var parts = [
    box(-c.halfW, -FACE_HALF_W, c.bottom, c.top, c.seam, c.front),
    box(FACE_HALF_W, c.halfW, c.bottom, c.top, c.seam, c.front),
    box(-FACE_HALF_W, FACE_HALF_W, FACE_HALF_H, c.top, c.seam, c.front),
    box(-FACE_HALF_W, FACE_HALF_W, c.bottom, -FACE_HALF_H, c.seam, c.front),
    box(-c.halfW, c.halfW, c.bottom, c.top, c.back, c.seam),
  ];
  var merged = mergeGeometries(parts);
  parts.forEach(function (p) {
    p.dispose();
  });
  return merged;
}

// options: { count, width, height: each picture's size in dots, phosphor,
// cabinetColor }
export function createBank(options) {
  var count = options.count;
  var W = options.width;
  var H = options.height;
  var layerSize = W * H;

  var data = new Uint8Array(layerSize * count);
  var signalTex = new DataArrayTexture(data, W, H, count);
  signalTex.format = RedFormat;
  signalTex.type = UnsignedByteType;
  signalTex.minFilter = LinearMipmapLinearFilter;
  signalTex.magFilter = LinearFilter;
  signalTex.wrapS = signalTex.wrapT = ClampToEdgeWrapping;
  signalTex.generateMipmaps = true;
  signalTex.unpackAlignment = 1;
  signalTex.needsUpdate = true;

  var faceGeo = createFaceGeometry(24, 18);
  var aLayer = new InstancedBufferAttribute(new Float32Array(count), 1);
  var aBeam = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
  var aLine = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
  for (var i = 0; i < count; i++) aLayer.setX(i, i);
  faceGeo.setAttribute("aLayer", aLayer);
  faceGeo.setAttribute("aBeam", aBeam);
  faceGeo.setAttribute("aLine", aLine);
  var faceMat = createFaceMaterial({ wall: true, width: W, height: H, phosphor: options.phosphor });
  faceMat.uniforms.uSig.value = signalTex;
  var faces = new InstancedMesh(faceGeo, faceMat, count);
  // Instances are spread over a whole wall; the one bounding sphere three
  // would cull by is the first set's.
  faces.frustumCulled = false;

  var cabinetGeo = createCabinetGeometry();
  var cabinetMat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.75, metalness: 0.0 });
  var cabinets = new InstancedMesh(cabinetGeo, cabinetMat, count);
  cabinets.frustumCulled = false;
  var cabinetColor = new Color(options.cabinetColor === undefined ? 0x2a2c2e : options.cabinetColor);

  var ledGeo = box(1.98, 2.12, -1.92, -1.78, CABINET.front, CABINET.front + 0.04);
  var ledMat = new MeshBasicMaterial({ color: 0xffffff });
  var leds = new InstancedMesh(ledGeo, ledMat, count);
  leds.frustumCulled = false;

  var powers = [];
  var apls = new Float32Array(count);
  for (var k = 0; k < count; k++) {
    powers.push(createPower(false));
    cabinets.setColorAt(k, cabinetColor);
    leds.setColorAt(k, LED_COLORS.off);
  }

  function writePower(i) {
    var p = powers[i];
    aBeam.setXYZW(i, p.gain, p.breath, 0, 0);
    aLine.setXYZW(i, p.line, p.lineV, p.lineH, p.spot);
    aBeam.needsUpdate = true;
    aLine.needsUpdate = true;
  }
  for (var w = 0; w < count; w++) writePower(w);

  return {
    count: count,
    width: W,
    height: H,
    faces: faces,
    cabinets: cabinets,
    leds: leds,
    material: faceMat,
    // Where set i stands. The matrix places the tube face; the cabinet and
    // lamp follow it.
    place: function (i, matrix) {
      faces.setMatrixAt(i, matrix);
      cabinets.setMatrixAt(i, matrix);
      leds.setMatrixAt(i, matrix);
      faces.instanceMatrix.needsUpdate = true;
      cabinets.instanceMatrix.needsUpdate = true;
      leds.instanceMatrix.needsUpdate = true;
    },
    // Set i's video signal: one byte per dot, first row at the top. Write
    // into it and call changed().
    signal: function (i) {
      return data.subarray(i * layerSize, (i + 1) * layerSize);
    },
    changed: function (i, level) {
      apls[i] = level;
      if (signalTex.addLayerUpdate) signalTex.addLayerUpdate(i);
      signalTex.needsUpdate = true;
    },
    setPower: function (i, on, instant) {
      if (instant) snapPower(powers[i], on);
      else setPower(powers[i], on);
      writePower(i);
    },
    power: function (i) {
      return powers[i];
    },
    setLed: function (i, state) {
      leds.setColorAt(i, LED_COLORS[state] || LED_COLORS.off);
      leds.instanceColor.needsUpdate = true;
    },
    // Takes set i's cabinet away, where a baked room has its own. Its face
    // and lamp stay.
    hideCabinet: function (i) {
      var m = new Matrix4().makeScale(0, 0, 0);
      cabinets.setMatrixAt(i, m);
      cabinets.instanceMatrix.needsUpdate = true;
    },
    setCabinetColor: function (i, color) {
      cabinets.setColorAt(i, color);
      cabinets.instanceColor.needsUpdate = true;
    },
    // Average light given off across the bank, 0-1.
    light: function () {
      var sum = 0;
      for (var i = 0; i < count; i++) sum += apls[i] * powers[i].gain;
      return count ? sum / count : 0;
    },
    // Steps every set that is switching on or off. Returns true while any is.
    update: function (dt) {
      var moving = false;
      for (var i = 0; i < count; i++) {
        if (stepPower(powers[i], dt, apls[i])) {
          writePower(i);
          moving = true;
        }
      }
      return moving;
    },
    dispose: function () {
      signalTex.dispose();
      faceGeo.dispose();
      faceMat.dispose();
      cabinetGeo.dispose();
      cabinetMat.dispose();
      ledGeo.dispose();
      ledMat.dispose();
    },
  };
}
