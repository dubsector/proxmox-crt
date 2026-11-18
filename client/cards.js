// What the screens say. A wall monitor shows a guest in 13 x 4 large
// characters, readable from the seat; the desk terminal shows the selected
// guest in the full 80 x 25. Everything here is text in a grid; the tubes
// turn it into a picture.
import { BOLD, DIM, INVERSE, GAUGE_ON, GAUGE_OFF } from "./gl/textgrid.js";

export var WALL_COLS = 13;
export var WALL_ROWS = 4;
export var DESK_COLS = 80;
export var DESK_ROWS = 25;

var GIB = 1024 * 1024 * 1024;
var SPARK = "▁▂▃▄▅▆▇█";

function bar(fraction, width) {
  var f = Math.max(0, Math.min(1, fraction || 0));
  var full = Math.round(f * width);
  // Anything running shows at least one segment.
  if (f > 0 && full === 0) full = 1;
  return GAUGE_ON.repeat(full) + GAUGE_OFF.repeat(width - full);
}

function percent(fraction) {
  return String(Math.round(Math.max(0, Math.min(1, fraction || 0)) * 100)).padStart(3) + "%";
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

export function uptime(seconds, long) {
  var s = Math.max(0, Math.floor(seconds || 0));
  var d = Math.floor(s / 86400);
  var h = Math.floor((s % 86400) / 3600);
  var m = Math.floor((s % 3600) / 60);
  if (long) return d + "d " + pad2(h) + "h " + pad2(m) + "m";
  if (d > 0) return d + "d " + pad2(h) + "h";
  if (h > 0) return h + "h " + pad2(m) + "m";
  return m + "m " + pad2(s % 60) + "s";
}

export function bytes(n) {
  var v = n || 0;
  if (v >= GIB) return (v / GIB).toFixed(v >= 10 * GIB ? 1 : 2) + " GiB";
  if (v >= 1048576) return (v / 1048576).toFixed(0) + " MiB";
  return (v / 1024).toFixed(0) + " KiB";
}

export function rate(bytesPerSecond) {
  var v = Math.max(0, bytesPerSecond || 0);
  if (v >= 1e6) return (v / 1e6).toFixed(1) + " MB/s";
  if (v >= 1e3) return (v / 1e3).toFixed(0) + " kB/s";
  return v.toFixed(0) + " B/s";
}

function kind(guest) {
  return guest.type === "qemu" ? "VM" : "CT";
}

function fit(text, width) {
  var s = String(text);
  return s.length > width ? s.slice(0, width - 1) + "~" : s;
}

function memFraction(g) {
  return g.maxmem ? g.mem / g.maxmem : 0;
}

// A guest on a wall monitor.
export function wallCard(grid, guest, number) {
  grid.clear();
  var running = guest.status === "running";
  grid.put(0, 0, pad2(number), running ? INVERSE : INVERSE | DIM);
  grid.put(3, 0, fit(kind(guest) + " " + guest.vmid, WALL_COLS - 3), running ? BOLD : DIM);
  grid.put(0, 1, fit(guest.name, WALL_COLS), running ? BOLD : DIM);
  if (running) {
    grid.put(0, 2, "C " + bar(guest.cpu, 7) + percent(guest.cpu));
    grid.put(0, 3, "M " + bar(memFraction(guest), 7) + percent(memFraction(guest)));
  } else {
    var word = " " + (guest.status === "stopped" ? "OFFLINE" : fit(String(guest.status).toUpperCase(), WALL_COLS - 2)) + " ";
    grid.put(Math.floor((WALL_COLS - word.length) / 2), 2, word, INVERSE);
    grid.put(0, 3, "PWR TO START", DIM);
  }
  return grid;
}

// A Proxmox node on one of the desk monitors.
export function nodeCard(grid, node, guests) {
  grid.clear();
  var online = node.status === "online";
  var here = guests.filter(function (g) {
    return g.node === node.node;
  });
  var up = here.filter(function (g) {
    return g.status === "running";
  }).length;
  grid.put(0, 0, "NODE", online ? INVERSE : INVERSE | DIM);
  grid.put(5, 0, fit(node.node, WALL_COLS - 5), BOLD);
  if (!online) {
    grid.put(2, 2, " OFFLINE ", INVERSE);
    return grid;
  }
  var mem = node.maxmem ? node.mem / node.maxmem : 0;
  grid.put(0, 1, up + "/" + here.length + " up");
  grid.put(0, 2, "C " + bar(node.cpu, 7) + percent(node.cpu));
  grid.put(0, 3, "M " + bar(mem, 7) + percent(mem));
  return grid;
}

function sparkline(values, width) {
  var out = "";
  var from = Math.max(0, values.length - width);
  for (var i = from; i < values.length; i++) {
    var v = Math.max(0, Math.min(1, values[i]));
    out += SPARK[Math.min(SPARK.length - 1, Math.floor(v * SPARK.length))];
  }
  return out;
}

// The selected guest on the desk terminal. `extra` carries what the page
// works out between snapshots: { history: [cpu...], netin, netout } in
// bytes per second.
export function deskCard(grid, state) {
  grid.clear();
  var node = state.node;
  var guest = state.guest;
  var header = " PROXMOX-CRT";
  if (node) {
    var nm = node.maxmem ? bytes(node.mem) + " / " + bytes(node.maxmem) : "";
    header +=
      "   node " + node.node + " " + node.status + "   cpu" + percent(node.cpu) + "   mem " + nm +
      "   load " + (node.loadavg || [0, 0, 0]).map(function (l) { return l.toFixed(2); }).join(" ");
  }
  grid.put(0, 0, fit(header, DESK_COLS).padEnd(DESK_COLS), INVERSE);

  if (!guest) {
    grid.put(2, 3, "NO MONITOR SELECTED", BOLD);
    grid.put(2, 5, "Type a monitor number on the numpad, or click a screen on the wall.");
    grid.put(2, 6, state.total + " guests on the wall.", DIM);
    return grid;
  }

  var running = guest.status === "running";
  grid.put(2, 2, "MONITOR " + pad2(state.number) + " / " + pad2(state.total), DIM);
  grid.put(2, 3, kind(guest) + " " + guest.vmid + "  " + fit(guest.name, 50), BOLD);
  var status = " " + String(guest.status).toUpperCase() + " ";
  grid.put(DESK_COLS - 2 - status.length, 3, status, running ? INVERSE : INVERSE | DIM);
  grid.put(2, 4, "on node " + guest.node + (guest.tags ? "   tags " + guest.tags : ""), DIM);

  if (!running) {
    grid.put(2, 7, "This guest is not running.", BOLD);
    grid.put(2, 9, "Its monitor on the wall shows OFFLINE. The power button on that monitor");
    grid.put(2, 10, "will start it once power control is wired up.");
    grid.put(2, 12, "Memory " + bytes(guest.maxmem) + "   cores " + guest.maxcpu + "   disk " + bytes(guest.maxdisk), DIM);
    return grid;
  }

  var extra = state.extra || {};
  var mem = memFraction(guest);
  var disk = guest.maxdisk ? guest.disk / guest.maxdisk : 0;
  grid.put(2, 6, "CPU   " + bar(guest.cpu, 40) + " " + percent(guest.cpu) + "   of " + guest.maxcpu + (guest.maxcpu === 1 ? " core" : " cores"));
  grid.put(2, 8, "MEM   " + bar(mem, 40) + " " + percent(mem) + "   " + bytes(guest.mem) + " / " + bytes(guest.maxmem));
  grid.put(2, 10, "DISK  " + bar(disk, 40) + " " + percent(disk) + "   " + bytes(guest.disk) + " / " + bytes(guest.maxdisk));
  grid.put(2, 12, "NET   in " + rate(extra.netin).padEnd(12) + " out " + rate(extra.netout));
  grid.put(2, 13, "UP    " + uptime(guest.uptime, true));

  grid.put(2, 16, "CPU HISTORY", DIM);
  grid.put(2, 17, sparkline(extra.history || [], DESK_COLS - 4));

  grid.put(2, 23, "numpad: monitor number   + -: next, previous   click: pick a screen", DIM);
  return grid;
}
