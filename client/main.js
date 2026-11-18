// Page entry: takes snapshots of the cluster from a source, turns them into
// what each screen says, and hands that to the scene. The keypad and clicks
// choose which guest the desk terminal shows.
import { createDemoSource } from "./demo.js";
import { createKeypad } from "./select.js";
import { createGrid } from "./gl/textgrid.js";
import { wallCard, nodeCard, deskCard, WALL_COLS, WALL_ROWS, DESK_COLS, DESK_ROWS } from "./cards.js";
import { createScene, wallLayout } from "./scene.js";
import { findBridge, createBridgeSource } from "./bridge.js";
import { createConsoles } from "./consoles.js";
import { openGate } from "./gate.js";

var params = new URLSearchParams(location.search);
var HUD = params.get("hud") === "1" || window.CRT_HUD === true;
var reducedMotion = params.get("motion") === "0" || (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
// How much CPU history the desk terminal's graph holds.
var HISTORY = DESK_COLS - 4;

var readout = document.getElementById("readout");
var hud = document.getElementById("hud");
var notice = document.getElementById("notice");
var linkNote = document.getElementById("link");
var CURSOR_BLINK_MS = 530;

// The cluster: the bridge's where a bridge serves this page, else the demo.
var source = null;
var consoles = null;
// What the desk terminal shows of the selected guest: its console, or its
// figures.
var deskMode = "console";
var selectedVmid = null;
var blinkOn = true;
var dragFrom = null;
var flashText = "";
var flashTimer = null;
var deskQueued = false;

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

// The node the guest runs on; with nothing selected, the first.
function nodeOf(guest) {
  for (var i = 0; guest && i < snapshot.nodes.length; i++) {
    if (snapshot.nodes[i].node === guest.node) return snapshot.nodes[i];
  }
  return snapshot.nodes[0];
}

// Puts text on the clipboard. Called from a click or a key, which is when
// a browser allows it. The clipboard API needs https or localhost, and the
// bridge serves plain http on a LAN, so there is an older way behind it.
function copy(text) {
  if (!text) return;
  function told(ok) {
    flash(ok ? "COPIED " + text.length + " CHARACTER" + (text.length === 1 ? "" : "S") : "COULD NOT COPY");
  }
  function oldWay() {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0";
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (e) {
      ok = false;
    }
    area.remove();
    if (typing()) consoles.focus(current().vmid);
    told(ok);
  }
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(function () {
      told(true);
    }, oldWay);
  } else {
    oldWay();
  }
}

// Says something on the readout for a moment.
function flash(text) {
  flashText = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(function () {
    flashText = "";
    drawReadout();
  }, 1600);
  drawReadout();
}

function current() {
  var n = keypad ? keypad.selected() : 0;
  return n ? guests[n - 1] : null;
}

// Whether the keyboard is the selected guest's just now.
function typing() {
  var guest = current();
  return !!(guest && consoles && deskMode === "console" && consoles.has(guest.vmid));
}

// Attaches the selected guest's console and gives it the keyboard. A
// stopped guest has none.
function attach() {
  var guest = current();
  selectedVmid = guest ? guest.vmid : null;
  if (!consoles) return;
  if (guest && guest.status === "running" && deskMode === "console") {
    consoles.open(guest);
    consoles.focus(guest.vmid);
  } else {
    consoles.blur();
  }
}

function queueDesk() {
  if (deskQueued) return;
  deskQueued = true;
  requestAnimationFrame(function () {
    deskQueued = false;
    if (scene && snapshot) drawDesk();
  });
}

function drawDesk() {
  var n = keypad.selected();
  var guest = n ? guests[n - 1] : null;
  if (typing()) {
    scene.showDesk(consoles.draw(guest.vmid, deskGrid, blinkOn));
    return;
  }
  scene.showDesk(
    deskCard(deskGrid, {
      node: nodeOf(guest),
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
  if (flashText) text = flashText;
  else if (entryText) text = "MON " + entryText + "_";
  else if (entryBad) text = "MON --";
  else if (guest)
    text =
      "MON " + String(n).padStart(2, "0") + "  " + (guest.type === "qemu" ? "VM" : "CT") + " " + guest.vmid + " " + guest.name +
      (consoles && guest.status === "running" ? (typing() ? "   console  (numpad . for figures)" : "   figures  (numpad . for console)") : "");
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
    if (node) scene.setNodeLoad(n + 1, node.status === "online" ? node.cpu : -1);
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
      // Dragging across the desk terminal's screen selects its text, and
      // letting go copies it, as a terminal's own window does.
      onDeskPress: function (cell) {
        if (!typing()) return false;
        dragFrom = cell;
        consoles.select(current().vmid, cell, cell, true);
        return true;
      },
      onDeskDrag: function (cell) {
        if (dragFrom && typing()) consoles.select(current().vmid, dragFrom, cell, true);
      },
      onDeskRelease: function () {
        if (!dragFrom || !typing()) return;
        var vmid = current().vmid;
        var sel = consoles.selection(vmid);
        dragFrom = null;
        // A click without a drag selects nothing, and clears what was.
        if (!sel || (sel.a.col === sel.b.col && sel.a.row === sel.b.row)) return consoles.select(vmid, null);
        consoles.select(vmid, sel.a, sel.b, false);
        copy(consoles.selectedText(vmid));
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
      // A newly selected guest is there to be typed into.
      deskMode = "console";
      attach();
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

function onSnapshot(snap) {
  snapshot = snap;
  guests = snap.guests.slice().sort(function (a, b) {
    return a.vmid - b.vmid;
  });
  track(snap);
  // A wall too small or too large for the guests there are now is rebuilt.
  if (scene) {
    var want = wallLayout(guests.length);
    if (want.columns !== scene.columns || want.rows !== scene.rows) {
      scene.canvas.remove();
      scene.dispose();
      scene = null;
    }
  }
  if (!scene) {
    if (!build(snap)) return;
  }
  keypad.resize(Math.min(guests.length, scene.wallCount), scene.columns);
  // Guests are numbered in order, so one added or removed moves the rest
  // along: keep hold of the guest that was selected, not of its number.
  if (selectedVmid !== null) {
    var at = 0;
    for (var i = 0; i < guests.length; i++) if (guests[i].vmid === selectedVmid) at = i + 1;
    if (at !== keypad.selected()) {
      if (at && at <= scene.wallCount) keypad.pick(at);
      else selectedVmid = null;
    }
  }
  if (consoles) {
    // A stopped guest's console is gone; one just started has one now.
    guests.forEach(function (g) {
      if (g.status !== "running" && consoles.has(g.vmid)) consoles.drop(g.vmid);
    });
    var guest = current();
    if (guest && guest.status === "running" && deskMode === "console" && !consoles.has(guest.vmid)) attach();
  }
  scene.setSelected(keypad.selected());
  draw();
}

function run(chosen) {
  source = chosen;
  if (source.console) {
    consoles = createConsoles({
          source: source,
      host: document.getElementById("consoles"),
      cols: DESK_COLS,
      rows: DESK_ROWS,
      keep: 4,
      // The numpad is the switcher's, whatever is being typed into.
      // So are paste and copy: Ctrl+V (or Cmd+V) is left to the browser,
      // which hands the terminal the clipboard; Ctrl+Shift+C copies what
      // is selected.
      reserved: function (ev) {
        return /^Numpad/.test(ev.code) || isPaste(ev) || isCopy(ev);
      },
      onChange: function (vmid) {
        if (vmid !== selectedVmid) return;
        blinkOn = true;
        queueDesk();
        drawReadout();
      },
    });
    setInterval(function () {
      blinkOn = !blinkOn;
      if (scene && snapshot && typing()) drawDesk();
    }, CURSOR_BLINK_MS);
  }
  source.subscribe(onSnapshot);
  source.start();
}

function isPaste(ev) {
  return (ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.code === "KeyV";
}

function isCopy(ev) {
  return ((ev.ctrlKey && ev.shiftKey) || ev.metaKey) && !ev.altKey && ev.code === "KeyC";
}

function demo() {
  return createDemoSource({ guests: params.has("guests") ? Math.max(0, parseInt(params.get("guests"), 10) || 0) : 48 });
}

function bridge() {
  return createBridgeSource({
    onLink: function (text) {
      linkNote.textContent = text ? "NO SIGNAL  " + text : "";
      linkNote.hidden = !text;
    },
    // The session ran out: ask for the password again and carry on.
    onLocked: function () {
      openGate({ configured: true, authed: false }).then(function () {
        source.start();
      });
    },
  });
}

// A host page with no bridge behind it can say so and save the asking.
if (params.get("demo") === "1" || window.CRT_DEMO === true) {
  run(demo());
} else {
  findBridge().then(function (state) {
    if (!state) return run(demo());
    if (state.configured && state.authed) return run(bridge());
    return openGate(state).then(function () {
      run(bridge());
    });
  });
}

// A click on the scene takes the keyboard from the hidden terminal; give
// it back.
window.addEventListener("pointerup", function () {
  if (typing()) consoles.focus(current().vmid);
});
window.addEventListener("focus", function () {
  if (typing()) consoles.focus(current().vmid);
});

window.addEventListener("keydown", function (ev) {
  if (!keypad) return;
  var numpad = /^Numpad/.test(ev.code);
  // While a console is on the desk, every key but the numpad is the guest's.
  if (typing() && isCopy(ev)) {
    copy(consoles.selectedText(current().vmid));
    ev.preventDefault();
    return;
  }
  if (typing() && !numpad) {
    if (!document.getElementById("consoles").contains(document.activeElement)) consoles.focus(current().vmid);
    return;
  }
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  // The numpad's point flips the desk between the console and the figures.
  if (ev.code === "NumpadDecimal") {
    if (consoles && current()) {
      deskMode = deskMode === "console" ? "stats" : "console";
      attach();
      drawDesk();
      drawReadout();
    }
    ev.preventDefault();
    return;
  }
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
  get source() {
    return source;
  },
  get consoles() {
    return consoles;
  },
  mode: function () {
    return deskMode;
  },
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
