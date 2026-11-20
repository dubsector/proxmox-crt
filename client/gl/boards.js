// The big displays on the wall beyond the monitors, and the row of lit
// signs along its top. One board says how the cluster stands: its storage
// and its latest tasks; the other plots how hard each node has been
// working over the last few minutes. Each sign is lit by something in the
// cluster (see telemetry.js). Plain shapes, like the rest of the grey-box
// room.
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

var TREND_POINTS = 150;
var TREND_EVERY_S = 1;
var TREND_COLORS = [0x66ff9a, 0xffa01a, 0xff5a3c, 0x7fc8ff];
var SIGN_CELL = 256;
var SIGN_FLASH_S = 0.6;
var FONT = "ui-monospace, Menlo, Consolas, monospace";
// How many lines of storage and of tasks the status board has room for.
var STATUS_ROWS = 8;
var STATE_COLORS = { ok: "#66ff9a", run: "#ffa01a", warn: "#ffa01a", fault: "#ff5a3c" };

function css(hex) {
  return "#" + ("000000" + hex.toString(16)).slice(-6);
}

function fit(text, width) {
  var t = String(text);
  return t.length > width ? t.slice(0, width - 1) + "~" : t;
}

function boardCanvas() {
  if (typeof document === "undefined") return null;
  var canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 600;
  if (!canvas.getContext("2d")) return null;
  var texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function title(ctx, text) {
  ctx.fillStyle = "#050b12";
  ctx.fillRect(0, 0, 1024, 600);
  ctx.fillStyle = "#9fd8e8";
  ctx.font = "bold 34px " + FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  var spaced = text.split("").join(" ");
  ctx.fillText(spaced, 30, 36);
  // Where the title ends, for what is written beside it.
  return 30 + ctx.measureText(spaced).width;
}

// The nodes' board: a title, the nodes' names in their pens' colours, and
// a chart's grid.
function drawChart(texture, heading, across, down, names) {
  var ctx = texture.image.getContext("2d");
  title(ctx, heading);
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
  ctx.font = "bold 26px " + FONT;
  ctx.textAlign = "right";
  var right = 994;
  for (var n = Math.min(names.length, TREND_COLORS.length) - 1; n >= 0; n--) {
    var name = fit(String(names[n]).toUpperCase(), 10);
    ctx.fillStyle = css(TREND_COLORS[n]);
    ctx.fillText(name, right, 36);
    right -= ctx.measureText(name).width + 28;
  }
  texture.needsUpdate = true;
}

// The status board: the cluster's name and how it stands along the top,
// storage on the left, fullest first, and the latest tasks on the right.
// board: see telemetry.js.
function drawStatus(texture, board) {
  var ctx = texture.image.getContext("2d");
  var titled = title(ctx, fit(board.cluster ? "CLUSTER " + board.cluster : "CLUSTER", 20));
  ctx.font = "bold 24px " + FONT;
  ctx.textAlign = "right";
  ctx.fillStyle = "#9fd8e8";
  ctx.fillText((board.summary || []).join("  "), 994, 36, 994 - titled - 30);

  ctx.strokeStyle = "#1f4a5c";
  ctx.lineWidth = 2;
  ctx.strokeRect(30, 70, 964, 500);
  ctx.beginPath();
  ctx.moveTo(500, 70);
  ctx.lineTo(500, 570);
  ctx.moveTo(30, 122);
  ctx.lineTo(994, 122);
  ctx.stroke();

  ctx.textAlign = "left";
  ctx.font = "bold 26px " + FONT;
  ctx.fillStyle = "#9fd8e8";
  ctx.fillText("S T O R A G E", 46, 97);
  ctx.fillText("T A S K S", 516, 97);

  var pitch = 448 / STATUS_ROWS;
  function rowY(r) {
    return 122 + (r + 0.5) * pitch;
  }
  function none(x, text) {
    ctx.fillStyle = "#3d6a7c";
    ctx.fillText(text, x, rowY(0));
  }

  ctx.font = "bold 25px " + FONT;
  if (!board.storage) none(46, "NO DATA");
  else if (!board.storage.length) none(46, "NONE LISTED");
  else {
    board.storage.slice(0, STATUS_ROWS).forEach(function (s, r) {
      var y = rowY(r);
      var color = STATE_COLORS[s.state] || STATE_COLORS.ok;
      // The storage's name, and after it the node whose it is; one they
      // share has none.
      var name = fit(String(s.name).toUpperCase(), 10);
      var whose = s.node ? " " + fit(String(s.node).toUpperCase(), 9) : "";
      var squeeze = Math.min(1, 196 / ctx.measureText(name + whose).width);
      var nameW = ctx.measureText(name).width * squeeze;
      ctx.textAlign = "left";
      ctx.fillStyle = "#9fd8e8";
      ctx.fillText(name, 46, y, nameW);
      ctx.fillStyle = "#5f93a3";
      if (whose) ctx.fillText(whose, 46 + nameW, y, ctx.measureText(whose).width * squeeze);
      ctx.fillStyle = "#0e2430";
      ctx.fillRect(256, y - 11, 160, 22);
      ctx.fillStyle = color;
      ctx.fillRect(256, y - 11, Math.max(3, 160 * s.used), 22);
      ctx.textAlign = "right";
      ctx.fillText(Math.round(s.used * 100) + "%", 486, y);
    });
  }

  ctx.textAlign = "left";
  if (!board.tasks) none(516, "NO DATA");
  else if (!board.tasks.length) none(516, "NONE YET");
  else {
    board.tasks.slice(0, STATUS_ROWS).forEach(function (task, r) {
      var y = rowY(r);
      ctx.textAlign = "left";
      ctx.fillStyle = "#5f93a3";
      ctx.fillText(task.ago, 516, y);
      ctx.fillStyle = "#9fd8e8";
      ctx.fillText(fit(String(task.what).toUpperCase(), 14), 576, y, 214);
      ctx.fillStyle = "#5f93a3";
      ctx.fillText(fit(String(task.node).toUpperCase(), 9), 800, y, 128);
      ctx.textAlign = "right";
      ctx.fillStyle = STATE_COLORS[task.state] || STATE_COLORS.ok;
      ctx.fillText(task.state === "run" ? "RUN" : task.state === "ok" ? "OK" : "ERR", 982, y);
    });
  }
  texture.needsUpdate = true;
}

// The signs, side by side on one strip, with a word on each: lit amber,
// red for a fault, or dark. One that warns is lit only while `flash` is on.
function drawSigns(texture, count, signs, flash) {
  var ctx = texture.image.getContext("2d");
  var cell = SIGN_CELL;
  ctx.fillStyle = "#0b0c0d";
  ctx.fillRect(0, 0, cell * count, 64);
  ctx.font = "bold 30px " + FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (var i = 0; i < count; i++) {
    var sign = signs[i % signs.length] || { word: "", state: "off" };
    var fault = sign.state === "fault";
    var lit = fault || sign.state === "ok" || (sign.state === "warn" && flash);
    ctx.fillStyle = fault ? "#ff3a20" : lit ? "#f0a030" : "#3a2a12";
    ctx.fillRect(i * cell + 10, 8, cell - 20, 48);
    ctx.fillStyle = fault ? "#240400" : lit ? "#1a0e02" : "#0e0a05";
    ctx.fillText(sign.word, (i + 0.5) * cell, 34, cell - 36);
  }
  texture.needsUpdate = true;
}

// options: { track: { x, y, z, width, height } the status board's middle
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
  function board(at) {
    shell.push(add(new BoxGeometry(at.width, at.height, 0.5), frameMat, at.x, at.y, at.z - 0.25));
    var texture = boardCanvas();
    var material = texture ? new MeshBasicMaterial({ map: texture }) : blankMat;
    if (texture) owned.push(material, texture);
    var w = at.width - 0.8;
    var h = at.height - 0.8;
    add(new PlaneGeometry(w, h), material, at.x, at.y, at.z + 0.02);
    // Where the grid is on the picture.
    return { texture: texture, left: at.x - w / 2 + (30 / 1024) * w, right: at.x - w / 2 + (994 / 1024) * w, top: at.y + h / 2 - (70 / 600) * h, bottom: at.y + h / 2 - (570 / 600) * h, z: at.z + 0.05 };
  }

  function line(points, color) {
    var geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(points * 3), 3));
    var material = new LineBasicMaterial({ color: color });
    owned.push(geometry, material);
    group.add(new Line(geometry, material));
    return geometry;
  }

  // --- the status board ------------------------------------------------------
  var status = board(options.track);
  var statusShown = "";
  if (status.texture) drawStatus(status.texture, { cluster: "", summary: [], storage: null, tasks: null });

  // --- the nodes' board --------------------------------------------------------
  var plot = board(options.trend);
  var namesShown = "";
  if (plot.texture) drawChart(plot.texture, "NODE LOAD", 10, 4, []);
  var nodes = Math.max(1, Math.min(options.nodes || 1, TREND_COLORS.length));
  var trends = [];
  for (var n = 0; n < nodes; n++) {
    var geometry = line(TREND_POINTS, TREND_COLORS[n]);
    var position = geometry.getAttribute("position");
    var values = new Float32Array(TREND_POINTS);
    for (var p = 0; p < TREND_POINTS; p++) position.setXYZ(p, plot.left + (p / (TREND_POINTS - 1)) * (plot.right - plot.left), plot.bottom, plot.z + n * 0.005);
    trends.push({ position: position, values: values, load: 0, begun: false });
  }
  function plotTrend(t) {
    for (var p = 0; p < TREND_POINTS; p++) t.position.setY(p, plot.bottom + t.values[p] * (plot.top - plot.bottom));
    t.position.needsUpdate = true;
  }

  // --- the signs -------------------------------------------------------------
  var signCount = 0;
  var signTexture = null;
  var signStates = [];
  var signsShown = "";
  var flashOn = true;
  var sinceFlash = 0;
  if (options.signs && typeof document !== "undefined") {
    signCount = Math.max(1, Math.round(options.signs.width / (options.signs.height * 4)));
    var strip = document.createElement("canvas");
    strip.width = SIGN_CELL * signCount;
    strip.height = 64;
    if (strip.getContext("2d")) {
      signTexture = new CanvasTexture(strip);
      signTexture.colorSpace = SRGBColorSpace;
      signTexture.anisotropy = 4;
      var signMat = new MeshBasicMaterial({ map: signTexture });
      owned.push(signMat, signTexture);
      // A little in front of where the strip is: a baked room's housing
      // for the signs has its face right there, and the two would fight.
      add(new PlaneGeometry(options.signs.width, options.signs.height), signMat, 0, options.signs.y, options.signs.z + 0.05);
      drawSigns(signTexture, signCount, [], true);
    }
  }
  function paintSigns() {
    if (!signTexture) return;
    // A room that keeps still does not flash: a warning stays lit.
    var flash = still || flashOn;
    var key = flash + JSON.stringify(signStates);
    if (key === signsShown) return;
    signsShown = key;
    drawSigns(signTexture, signCount, signStates, flash);
  }

  var sinceSample = 0;

  return {
    group: group,
    shell: shell,
    // How hard node i is working, 0..1 (below 0: it is down).
    setLoad: function (i, load) {
      if (!trends[i]) return;
      trends[i].load = Math.max(0, Math.min(1, load));
      // A room that keeps still shows where things stand now, and a pen
      // just set down starts from where the node is, not from nothing.
      if (still || !trends[i].begun) {
        trends[i].begun = true;
        trends[i].values.fill(trends[i].load);
        plotTrend(trends[i]);
      }
    },
    // How many signs there are.
    signCount: signCount,
    // What the signs say: [{ word, state: "ok" (lit), "off" (dark), "warn"
    // (flashing) or "fault" (red) }], left to right.
    setSigns: function (signs) {
      signStates = signs || [];
      paintSigns();
    },
    // What the status board says (see telemetry.js).
    setStatus: function (board) {
      if (!status.texture) return;
      var key = JSON.stringify(board);
      if (key === statusShown) return;
      statusShown = key;
      drawStatus(status.texture, board);
    },
    // The nodes' names, for the nodes' board, in the order of their pens.
    setNames: function (names) {
      if (!plot.texture) return;
      var key = (names || []).join("\n");
      if (key === namesShown) return;
      namesShown = key;
      drawChart(plot.texture, "NODE LOAD", 10, 4, names || []);
    },
    // Moves everything on by dt seconds. True while anything is moving,
    // which is always unless the room is to keep still.
    update: function (dt) {
      if (still) return false;
      sinceFlash += dt;
      if (sinceFlash >= SIGN_FLASH_S) {
        sinceFlash = 0;
        flashOn = !flashOn;
        paintSigns();
      }
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
