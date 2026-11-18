// Page entry: takes snapshots of the cluster from a source, turns them into
// what each screen says, and hands that to the scene. The keypad and clicks
// choose which guest the desk terminal shows.
import { createDemoSource } from "./demo.js";
import { createKeypad } from "./select.js";
import { createGrid } from "./gl/textgrid.js";
import { wallCard, nodeCard, deskCard, WALL_COLS, WALL_ROWS, DESK_COLS, DESK_ROWS } from "./cards.js";
import { createScene } from "./scene.js";

var params = new URLSearchParams(location.search);
var HUD = params.get("hud") === "1" || window.CRT_HUD === true;
var reducedMotion = params.get("motion") === "0" || (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
// How much CPU history the desk terminal's graph holds.
var HISTORY = DESK_COLS - 4;

var readout = document.getElementById("readout");
var hud = document.getElementById("hud");
var notice = document.getElementById("notice");

// Until the bridge exists, the cluster is the demo one.
var source = createDemoSource({ guests: params.has("guests") ? Math.max(0, parseInt(params.get("guests"), 10) || 0) : 48 });

var scene = null;
var keypad = null;
var snapshot = null;
var guests = []; // in wall order: monitor n shows guests[n - 1]
var previous = {}; // vmid -> { netin, netout, t }
var extras = {}; // vmid -> { history, netin, netout }
var wallGrid = createGrid(WALL_COLS, WALL_ROWS);
var deskGrid = createGrid(DESK_COLS, DESK_ROWS);
var entryText = "";
var entryBad = false;
var badTimer = null;

function fail(message) {
  notice.textContent = "The 3D view could not start: " + message;
  notice.hidden = false;
}

function track(snap) {
  snap.guests.forEach(function (g) {
    var e = extras[g.vmid] || (extras[g.vmid] = { history: [], netin: 0, netout: 0 });
    var p = previous[g.vmid];
    if (p && snap.t > p.t && g.status === "running") {
      e.netin = Math.max(0, g.netin - p.netin) / (snap.t - p.t);
      e.netout = Math.max(0, g.netout - p.netout) / (snap.t - p.t);
    } else {
      e.netin = e.netout = 0;
    }
    previous[g.vmid] = { netin: g.netin, netout: g.netout, t: snap.t };
    e.history.push(g.status === "running" ? g.cpu : 0);
    if (e.history.length > HISTORY) e.history.shift();
  });
}

function drawDesk() {
  var n = keypad.selected();
  var guest = n ? guests[n - 1] : null;
  scene.showDesk(
    deskCard(deskGrid, {
      node: snapshot.nodes[0],
      guest: guest,
      number: n,
      total: guests.length,
      extra: guest ? extras[guest.vmid] : null,
    })
  );
}

function drawReadout() {
  var n = keypad ? keypad.selected() : 0;
  var guest = n ? guests[n - 1] : null;
  var text;
  if (entryText) text = "MON " + entryText + "_";
  else if (entryBad) text = "MON --";
  else if (guest) text = "MON " + String(n).padStart(2, "0") + "  " + (guest.type === "qemu" ? "VM" : "CT") + " " + guest.vmid + " " + guest.name;
  else text = "MON --  type a number or click a screen";
  readout.textContent = text;
}

function draw() {
  for (var i = 0; i < scene.wallCount; i++) {
    var g = guests[i];
    if (!g) scene.show(i + 1, null, "off");
    else scene.show(i + 1, wallCard(wallGrid, g, i + 1), g.status === "running" ? "live" : "offline");
  }
  for (var n = 0; n < scene.nodeCount; n++) {
    var node = snapshot.nodes[n];
    if (!node) scene.show(n + 1, null, "off", true);
    else scene.show(n + 1, nodeCard(wallGrid, node, snapshot.guests), node.status === "online" ? "live" : "offline", true);
  }
  drawDesk();
  drawReadout();
}

function build(snap) {
  try {
    scene = createScene({
      guests: snap.guests.length,
      nodes: snap.nodes.length,
      reducedMotion: reducedMotion,
      always: HUD,
      onPick: function (number) {
        keypad.pick(number);
      },
    });
  } catch (err) {
    fail(err && err.message ? err.message : String(err));
    return false;
  }
  document.body.appendChild(scene.canvas);
  keypad = createKeypad({
    count: Math.min(snap.guests.length, scene.wallCount),
    columns: scene.columns,
    onSelect: function (number) {
      scene.setSelected(number);
      drawDesk();
      drawReadout();
    },
    onEntry: function (text, bad) {
      entryText = text;
      entryBad = bad;
      clearTimeout(badTimer);
      if (bad) {
        badTimer = setTimeout(function () {
          entryBad = false;
          drawReadout();
        }, 900);
      }
      drawReadout();
    },
  });
  return true;
}

source.subscribe(function (snap) {
  snapshot = snap;
  guests = snap.guests.slice().sort(function (a, b) {
    return a.vmid - b.vmid;
  });
  track(snap);
  if (!scene && !build(snap)) return;
  keypad.resize(Math.min(guests.length, scene.wallCount), scene.columns);
  draw();
});
source.start();

window.addEventListener("keydown", function (ev) {
  if (!keypad || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  // Page Down holds the view on the keyboard and Page Up on the seat; Home
  // lets it follow the pointer again.
  if (ev.code === "PageUp" || ev.code === "PageDown" || ev.code === "Home") {
    scene.setView(ev.code === "PageUp" ? "seat" : ev.code === "PageDown" ? "keys" : null);
    ev.preventDefault();
    return;
  }
  if (keypad.key(ev.code)) ev.preventDefault();
});

if (HUD) {
  hud.hidden = false;
  setInterval(function () {
    if (!scene) return;
    var s = scene.stats();
    hud.textContent =
      s.fps.toFixed(0) + " fps   " + s.monitors + " monitors   " + s.calls + " draw calls   " + s.triangles + " triangles" +
      (s.shaderError ? "   SHADER ERROR" : "");
  }, 500);
}

// For automated checks: what state the page is in, and where things are so
// a test can click them.
window.__crt = {
  get scene() {
    return scene;
  },
  get keypad() {
    return keypad;
  },
  source: source,
  guests: function () {
    return guests;
  },
  deskLines: function () {
    return deskGrid.lines();
  },
  readout: function () {
    return readout.textContent;
  },
};
