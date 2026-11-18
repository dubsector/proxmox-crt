// Takes the desk lamp out of terminal's baked scene (src/assets/scene.glb
// there) and writes it as client/gl/lamp-model.js: each part's positions,
// normals and triangles, in the lamp's own frame and in metres.
//
//   node tools/extract-lamp.mjs ../terminal/src/assets/scene.glb
import { readFileSync, writeFileSync } from "node:fs";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

var PARTS = ["Lamp_Base", "Lamp_Arm", "Lamp_Shade", "Lamp_ShadeGlow"];
var SIZES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
var COUNTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

var file = readFileSync(process.argv[2]);
var jsonLength = file.readUInt32LE(12);
var gltf = JSON.parse(file.subarray(20, 20 + jsonLength).toString("utf8"));
var bin = file.subarray(20 + jsonLength + 8);
await MeshoptDecoder.ready;

var views = {};
function view(index) {
  if (views[index]) return views[index];
  var v = gltf.bufferViews[index];
  var packed = v.extensions && v.extensions.EXT_meshopt_compression;
  if (!packed) return (views[index] = { bytes: bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength), stride: v.byteStride });
  var out = new Uint8Array(packed.count * packed.byteStride);
  var from = bin.subarray(packed.byteOffset || 0, (packed.byteOffset || 0) + packed.byteLength);
  MeshoptDecoder.decodeGltfBuffer(out, packed.count, packed.byteStride, from, packed.mode, packed.filter);
  return (views[index] = { bytes: Buffer.from(out.buffer), stride: packed.byteStride });
}

// An accessor's values as plain numbers, normalised where it says so.
function read(index) {
  var a = gltf.accessors[index];
  var v = view(a.bufferView);
  var n = COUNTS[a.type];
  var size = SIZES[a.componentType];
  var stride = v.stride || n * size;
  var out = new Array(a.count * n);
  for (var i = 0; i < a.count; i++) {
    for (var c = 0; c < n; c++) {
      var at = (a.byteOffset || 0) + i * stride + c * size;
      var x;
      if (a.componentType === 5126) x = v.bytes.readFloatLE(at);
      else if (a.componentType === 5125) x = v.bytes.readUInt32LE(at);
      else if (a.componentType === 5123) x = a.normalized ? v.bytes.readUInt16LE(at) / 65535 : v.bytes.readUInt16LE(at);
      else if (a.componentType === 5122) x = a.normalized ? Math.max(v.bytes.readInt16LE(at) / 32767, -1) : v.bytes.readInt16LE(at);
      else if (a.componentType === 5121) x = a.normalized ? v.bytes.readUInt8(at) / 255 : v.bytes.readUInt8(at);
      else x = a.normalized ? Math.max(v.bytes.readInt8(at) / 127, -1) : v.bytes.readInt8(at);
      out[i * n + c] = x;
    }
  }
  return out;
}

function b64(typed) {
  return Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString("base64");
}

var lines = ["// The desk lamp from terminal, taken out of its baked scene by", "// tools/extract-lamp.mjs. Each part: positions and normals (32-bit floats)", "// and triangles (16-bit), base64. Metres, in the lamp's own frame: the base", "// at the origin, +Y up.", "export var LAMP_PARTS = {"];
PARTS.forEach(function (name) {
  var node = gltf.nodes.find(function (n) {
    return n.name === name;
  });
  var position = [];
  var normal = [];
  var index = [];
  gltf.meshes[node.mesh].primitives.forEach(function (p) {
    var base = position.length / 3;
    var s = node.scale || [1, 1, 1];
    read(p.attributes.POSITION).forEach(function (x, i) {
      position.push(x * s[i % 3]);
    });
    read(p.attributes.NORMAL).forEach(function (x) {
      normal.push(x);
    });
    read(p.indices).forEach(function (i) {
      index.push(base + i);
    });
  });
  console.log(name, position.length / 3, "vertices", index.length / 3, "triangles", Object.keys(gltf.meshes[node.mesh].primitives[0].attributes).join(","));
  lines.push("  " + name.replace("Lamp_", "").toLowerCase() + ": {", '    position: "' + b64(new Float32Array(position)) + '",', '    normal: "' + b64(new Float32Array(normal)) + '",', '    index: "' + b64(new Uint16Array(index)) + '",', "  },");
});
lines.push("};", "");
writeFileSync(new URL("../client/gl/lamp-model.js", import.meta.url), lines.join("\n"));
