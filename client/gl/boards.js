// The big displays on the wall beyond the monitors, and the row of lit
// signs along its top. One board follows a track round a chart, as a
// tracking board does; the other plots how hard each node has been
// working over the last few minutes. Plain shapes, like the rest of the
// grey-box room.
import {
  Group,
  Mesh,
  Line,
  BoxGeometry,
  PlaneGeometry,
  BufferGeometry,
  BufferAttribute,
  MeshStandardMaterial,
  MeshBasicMaterial,
  LineBasicMaterial,
  CanvasTexture,
  SRGBColorSpace,
} from "three";

var TRACK_POINTS = 120;
var TREND_POINTS = 150;
var TREND_EVERY_S = 1;
var TREND_COLORS = [0x66ff9a, 0xffa01a, 0xff5a3c, 0x7fc8ff];
var SIGN_WORDS = ["POWER", "NETWORK", "STORAGE", "CLUSTER", "GUESTS", "BACKUP", "CONSOLE", "TELEMETRY", "RANGE", "COMM", "GUIDANCE", "RECORDERS", "TIMING", "WEATHER", "SAFETY", "SUPPORT"];

// A board's background: a title along the top and a chart's grid.
function chartTexture(title, across, down) {
  if (typeof document === "undefined") return null;
  var canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 600;
  var ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#050b12";
  ctx.fillRect(0, 0, 1024, 600);
  ctx.strokeStyle = "#1f4a5c";
  ctx.lineWidth = 2;
  for (var c = 0; c <= across; c++) {
    var x = 30 + (c / across) * 964;
    ctx.beginPath();
    ctx.moveTo(x, 70);
    ctx.lineTo(x, 570);
    ctx.stroke();
  }
  for (var r = 0; r <= down; r++) {
    var y = 70 + (r / down) * 500;
    ctx.beginPath();
    ctx.moveTo(30, y);
    ctx.lineTo(994, y);
    ctx.stroke();
  }
  ctx.fillStyle = "#9fd8e8";
  ctx.font = "bold 34px ui-monospace, Menlo, Consolas, monospace";
  ctx.textBaseline = "middle";
  ctx.fillText(title.split("").join(" "), 30, 36);
  var texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

// The signs, side by side on one strip: lit amber, with a word on each.
function signTexture(count) {
  if (typeof document === "undefined") return null;
  var cell = 256;
  var canvas = document.createElement("canvas");
  canvas.width = cell * count;
  canvas.height = 64;
  var ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#0b0c0d";
  ctx.fillRect(0, 0, canvas.width, 64);
  ctx.font = "bold 30px ui-monospace, Menlo, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (var i = 0; i < count; i++) {
    // Most are lit; a few wait their turn.
    var lit = i % 5 !== 3;
    ctx.fillStyle = lit ? "#f0a030" : "#3a2a12";
    ctx.fillRect(i * cell + 10, 8, cell - 20, 48);
    ctx.fillStyle = lit ? "#1a0e02" : "#0e0a05";
    ctx.fillText(SIGN_WORDS[i % SIGN_WORDS.length], (i + 0.5) * cell, 34);
  }
  var texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

// options: { track: { x, y, z, width, height } the tracking board's middle
// and size, trend: the same for the nodes' board, nodes: how many nodes it
// plots, signs: { y, z, width, height } the strip of signs, still: no
// movement (reduced motion) }
export function createBoards(options) {
  var group = new Group();
  var owned = [];
  var still = !!options.still;

  var frameMat = new MeshStandardMaterial({ color: 0x23272b, roughness: 0.55, metalness: 0.35 });
  var blankMat = new MeshBasicMaterial({ color: 0x050b12 });
  owned.push(frameMat, blankMat);

  function add(geometry, material, x, y, z) {
    var m = new Mesh(geometry, material);
    m.position.set(x, y, z);
    owned.push(geometry);
    group.add(m);
    return m;
  }

  // The boards' frames: what a baked room draws for itself.
  var shell = [];
  // A board: its frame, and its chart, whose plotting area is returned.
  function board(at, title, across, down) {
    shell.push(add(new BoxGeometry(at.width, at.height, 0.5), frameMat, at.x, at.y, at.z - 0.25));
    var texture = chartTexture(title, across, down);
    var material = texture ? new MeshBasicMaterial({ map: texture }) : blankMat;
    if (texture) owned.push(material, texture);
    var w = at.width - 0.8;
    var h = at.height - 0.8;
    add(new PlaneGeometry(w, h), material, at.x, at.y, at.z + 0.02);
    // Where the grid is on the picture.
    return { left: at.x - w / 2 + (30 / 1024) * w, right: at.x - w / 2 + (994 / 1024) * w, top: at.y + h / 2 - (70 / 600) * h, bottom: at.y + h / 2 - (570 / 600) * h, z: at.z + 0.05 };
  }

  function line(points, color) {
    var geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(points * 3), 3));
    var material = new LineBasicMaterial({ color: color });
    owned.push(geometry, material);
    group.add(new Line(geometry, material));
    return geometry;
  }

  // --- the tracking board ----------------------------------------------------
  // Each pass round is a wave across the chart, a little further along
  // than the one before, as a ground track is.
  var chart = board(options.track, "TRACK", 12, 6);
  var midY = (chart.top + chart.bottom) / 2;
  var swing = (chart.top - chart.bottom) * 0.36;
  function trackAt(f, pass, out) {
    out[0] = chart.left + f * (chart.right - chart.left);
    out[1] = midY + Math.sin((f * 1.5 + pass * 0.19) * Math.PI * 2) * swing;
  }
  var xy = [0, 0];
  [0, 1, 2].forEach(function (pass) {
    var geometry = line(TRACK_POINTS, pass === 0 ? 0xffa01a : 0x6b4a14);
    var position = geometry.getAttribute("position");
    for (var p = 0; p < TRACK_POINTS; p++) {
      trackAt(p / (TRACK_POINTS - 1), pass, xy);
      position.setXYZ(p, xy[0], xy[1], chart.z);
    }
  });
  var blipMat = new MeshBasicMaterial({ color: 0xfff2c0 });
  owned.push(blipMat);
  var blip = add(new PlaneGeometry(0.45, 0.45), blipMat, 0, 0, chart.z + 0.02);
  blip.rotation.z = Math.PI / 4;
  var along = 0.37;
  function placeBlip() {
    trackAt(along, 0, xy);
    blip.position.x = xy[0];
    blip.position.y = xy[1];
  }
  placeBlip();

  // --- the nodes' board --------------------------------------------------------
  var plot = board(options.trend, "NODE LOAD", 10, 4);
  var nodes = Math.max(1, Math.min(options.nodes || 1, TREND_COLORS.length));
  var trends = [];
  for (var n = 0; n < nodes; n++) {
    var geometry = line(TREND_POINTS, TREND_COLORS[n]);
    var position = geometry.getAttribute("position");
    var values = new Float32Array(TREND_POINTS);
    for (var p = 0; p < TREND_POINTS; p++) position.setXYZ(p, plot.left + (p / (TREND_POINTS - 1)) * (plot.right - plot.left), plot.bottom, plot.z + n * 0.005);
    trends.push({ position: position, values: values, load: 0 });
  }
  function plotTrend(t) {
    for (var p = 0; p < TREND_POINTS; p++) t.position.setY(p, plot.bottom + t.values[p] * (plot.top - plot.bottom));
    t.position.needsUpdate = true;
  }

  // --- the signs -------------------------------------------------------------
  if (options.signs) {
    var count = Math.max(1, Math.round(options.signs.width / (options.signs.height * 4)));
    var signs = signTexture(count);
    if (signs) {
      var signMat = new MeshBasicMaterial({ map: signs });
      owned.push(signMat, signs);
      add(new PlaneGeometry(options.signs.width, options.signs.height), signMat, 0, options.signs.y, options.signs.z);
    }
  }

  var sinceSample = 0;

  return {
    group: group,
    shell: shell,
    // How hard node i is working, 0..1 (below 0: it is down).
    setLoad: function (i, load) {
      if (!trends[i]) return;
      trends[i].load = Math.max(0, Math.min(1, load));
      // A room that keeps still shows where things stand now.
      if (still) {
        trends[i].values.fill(trends[i].load);
        plotTrend(trends[i]);
      }
    },
    // Moves everything on by dt seconds. True while anything is moving,
    // which is always unless the room is to keep still.
    update: function (dt) {
      if (still) return false;
      along = (along + dt / 90) % 1;
      placeBlip();
      sinceSample += dt;
      if (sinceSample >= TREND_EVERY_S) {
        sinceSample = 0;
        trends.forEach(function (t) {
          t.values.copyWithin(0, 1);
          // A pen is never quite steady.
          t.values[TREND_POINTS - 1] = Math.max(0, Math.min(1, t.load + (Math.random() - 0.5) * 0.02));
          plotTrend(t);
        });
      }
      return true;
    },
    dispose: function () {
      owned.forEach(function (o) {
        o.dispose();
      });
    },
  };
}
