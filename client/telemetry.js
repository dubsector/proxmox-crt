// What the room's gear says about the cluster: the racks' clocks, lamps,
// meters and scopes, the cabinets under the wall, the signs along the top
// and the status board. Everything here is worked out from the snapshots
// (see demo.js for their shape); nothing is made up, and what a snapshot
// does not say is shown as not known: a dark lamp, a needle at rest, dashes
// on a clock.
//
// Nothing here draws. scene.js hands each part to the gear that shows it.

// A lamp on a rack's board.
export var DARK = 0;
export var GREEN = 1;
export var AMBER = 2;
export var RED = 3;

// The signs along the top of the wall, left to right.
export var SIGNS = ["QUORUM", "NODES", "GUESTS", "CPU", "MEMORY", "SWAP", "IO WAIT", "LOAD", "STORAGE", "BACKUP", "TASKS", "MIGRATE", "NETWORK", "DISK IO", "BRIDGE", "UPTIME", "ALARM"];

// Where the racks stand: two beside the monitors, two in the corners, and
// two along each side wall.
export var RACKS = 8;

var KB = 1e3;

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// How busy a rate of bytes a second is, 0..1: nothing below a kilobyte a
// second, everything at a hundred megabytes.
export function activity(bytesPerSecond) {
  if (!(bytesPerSecond > KB)) return 0;
  return clamp01(Math.log10(bytesPerSecond / KB) / 5);
}

// How long a rate is kept while its counters stand still, in seconds.
var RATE_HOLD_S = 30;

// Rates from counters that only ever go up, such as a guest's bytes in and
// out. Proxmox brings its counters up to date every ten seconds or so, and
// the cluster is read more often than that: between two of its updates a
// counter stands still, and the difference from one reading to the next
// would be nothing, nothing, nothing, then everything at once. So a rate is
// taken from one change of the counters to the next, and kept in between.
export function createRates() {
  var kept = {}; // key -> { t, counters, rates }
  return {
    // The rates for `key`, in units a second: { name: rate } for each of
    // `counters` ({ name: count }) at time `t`. With `live` false (a guest
    // that is not running) there are none, and counting starts afresh.
    read: function (key, t, counters, live) {
      var names = Object.keys(counters);
      var was = kept[key];
      var zero = {};
      names.forEach(function (name) {
        zero[name] = 0;
      });
      if (!was || live === false || !(t > was.t)) {
        if (!was || live === false) kept[key] = { t: t, counters: counters, rates: zero };
        return was && live !== false ? was.rates : zero;
      }
      var changed = names.some(function (name) {
        return counters[name] !== was.counters[name];
      });
      if (changed) {
        var rates = {};
        names.forEach(function (name) {
          // A counter that went down was reset: the guest restarted.
          rates[name] = Math.max(0, counters[name] - (was.counters[name] || 0)) / (t - was.t);
        });
        kept[key] = { t: t, counters: counters, rates: rates };
        return rates;
      }
      // Still for longer than Proxmox takes: nothing is moving.
      if (t - was.t > RATE_HOLD_S) was.rates = zero;
      return was.rates;
    },
    // Forgets every key `keep(key)` is not true for.
    prune: function (keep) {
      Object.keys(kept).forEach(function (key) {
        if (!keep(key)) delete kept[key];
      });
    },
  };
}

// A lamp for how full something is.
function fillLamp(fraction, warn, fault) {
  return fraction >= fault ? RED : fraction >= warn ? AMBER : GREEN;
}

function fraction(used, total) {
  return total > 0 ? clamp01(used / total) : 0;
}

function running(g) {
  return g.status === "running";
}

function online(n) {
  return n.status === "online";
}

// How long ago, in a few characters: 40s, 12m, 7h, 3d.
export function ago(seconds) {
  var s = Math.max(0, Math.floor(seconds));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}

// options: { lamps: how many lamps a rack's board has, lampCols: how many
// of them to a row, machines: how many cabinets stand under the wall,
// history: how many readings a scope holds }
export function createTelemetry(options) {
  var opts = options || {};
  var lampCount = opts.lamps || 70;
  var lampCols = opts.lampCols || 5;
  var machineCount = opts.machines || 16;
  var points = opts.history || 96;

  var counted = createRates();
  // A rate takes two readings: there is none to plot until the second.
  var readings = 0;
  var traces = {}; // name -> Float32Array of the latest readings

  function trace(name, value) {
    var t = traces[name];
    if (!t) {
      // A scope just switched on shows the first reading right across.
      t = traces[name] = new Float32Array(points).fill(value);
    } else {
      t.copyWithin(0, 1);
      t[points - 1] = value;
    }
    return t;
  }

  // A trace as a scope shows it: 0..1 of the largest reading on it, with
  // `floor` the least that fills the screen, so a quiet line stays low.
  function scoped(name, floor) {
    var t = traces[name];
    if (!t) return null;
    var peak = floor;
    for (var i = 0; i < points; i++) if (t[i] > peak) peak = t[i];
    var out = new Float32Array(points);
    for (var p = 0; p < points; p++) out[p] = t[p] / peak;
    return out;
  }

  function lamps(codes) {
    var out = new Uint8Array(lampCount);
    for (var i = 0; i < codes.length && i < lampCount; i++) out[i] = codes[i];
    return out;
  }

  return {
    // What everything shows for this snapshot. Readings are taken in
    // order: rates and the scopes' traces come from one snapshot to the next.
    read: function (snap) {
      var nodes = snap.nodes || [];
      var guests = (snap.guests || []).slice().sort(function (a, b) {
        return a.vmid - b.vmid;
      });
      var storage = snap.storage || null;
      var tasks = snap.tasks || null;
      var up = nodes.filter(online);

      // --- rates -------------------------------------------------------------
      var rates = { netin: 0, netout: 0, read: 0, write: 0 };
      var byNode = {};
      var guestRate = {};
      var seen = {};
      guests.forEach(function (g) {
        var now = counted.read(g.vmid, snap.t, { netin: g.netin || 0, netout: g.netout || 0, read: g.diskread || 0, write: g.diskwrite || 0 }, running(g));
        rates.netin += now.netin;
        rates.netout += now.netout;
        rates.read += now.read;
        rates.write += now.write;
        var r = { net: now.netin + now.netout, disk: now.read + now.write };
        var n = byNode[g.node] || (byNode[g.node] = { net: 0, disk: 0 });
        n.net += r.net;
        n.disk += r.disk;
        guestRate[g.vmid] = r;
        seen[g.vmid] = true;
      });
      counted.prune(function (vmid) {
        return seen[vmid];
      });

      // --- the cluster as a whole ---------------------------------------------
      var cores = 0;
      var busy = 0;
      var mem = 0;
      var maxmem = 0;
      var load = 0;
      var wait = null;
      var swap = null;
      up.forEach(function (n) {
        cores += n.maxcpu || 0;
        busy += (n.cpu || 0) * (n.maxcpu || 0);
        mem += n.mem || 0;
        maxmem += n.maxmem || 0;
        if (n.loadavg) load += n.loadavg[0] || 0;
        if (typeof n.wait === "number") wait = Math.max(wait || 0, n.wait);
        if (n.maxswap > 0) swap = Math.max(swap || 0, fraction(n.swap, n.maxswap));
      });
      var cpu = fraction(busy, cores);
      var memory = fraction(mem, maxmem);
      var stores = (storage || []).filter(function (s) {
        return s.maxdisk > 0;
      });
      var fullest = 0;
      var stored = 0;
      var storeRoom = 0;
      stores.forEach(function (s) {
        fullest = Math.max(fullest, fraction(s.disk, s.maxdisk));
        stored += s.disk;
        storeRoom += s.maxdisk;
      });
      var storageDown = (storage || []).some(function (s) {
        return s.status && s.status !== "available";
      });

      // --- tasks -------------------------------------------------------------
      var lastEnded = null;
      var lastBackup = null;
      var migrating = false;
      var active = 0;
      (tasks || []).forEach(function (task) {
        var ended = typeof task.end === "number";
        if (!ended) {
          active++;
          if (/migrate/.test(task.type)) migrating = true;
        }
        if (ended && (!lastEnded || task.end > lastEnded.end)) lastEnded = task;
        if (task.type === "vzdump" && (!lastBackup || task.start > lastBackup.start)) lastBackup = task;
      });
      function since(task) {
        return task && typeof task.end === "number" ? { seconds: Math.max(0, snap.t - task.end), ticking: true, form: "hms" } : { seconds: null };
      }

      // --- the scopes' traces ------------------------------------------------
      readings++;
      trace("cpu", cpu);
      if (readings > 1) {
        trace("net", rates.netin + rates.netout);
        trace("netin", rates.netin);
        trace("netout", rates.netout);
        trace("disk", rates.read + rates.write);
        trace("write", rates.write);
      }
      trace("load", cores ? load / cores : 0);
      nodes.forEach(function (n) {
        trace("node:" + n.node, online(n) ? n.cpu || 0 : 0);
      });

      // --- the racks ---------------------------------------------------------
      function nodeMeters(value) {
        return [0, 1, 2].map(function (i) {
          return nodes[i] && online(nodes[i]) ? value(nodes[i]) : null;
        });
      }
      function cpuLamp(g) {
        return !running(g) ? RED : g.cpu >= 0.8 ? AMBER : GREEN;
      }
      var racks = [];
      // Left of the monitors: the guests, in the wall's order.
      racks.push({
        // The time of day on the host, by its own clock and time zone.
        label: "PVE TIME",
        clock: typeof snap.time === "number" ? { seconds: snap.time, ticking: true, form: "day" } : { seconds: null },
        lamps: lamps(guests.map(cpuLamp)),
        meters: nodeMeters(function (n) {
          return n.cpu || 0;
        }),
        scope: scoped("cpu", 0.05),
      });
      // Right of them: their memory.
      racks.push({
        label: "SINCE BACKUP",
        clock: since(lastBackup),
        lamps: lamps(
          guests.map(function (g) {
            return running(g) ? fillLamp(fraction(g.mem, g.maxmem), 0.75, 0.9) : DARK;
          }),
        ),
        meters: nodeMeters(function (n) {
          return fraction(n.mem, n.maxmem);
        }),
        scope: scoped("net", 10 * KB),
      });
      // The left corner, by the status board: storage, a row of lamps to
      // each, lit as far as it is full.
      var bars = [];
      stores.forEach(function (s) {
        var f = fraction(s.disk, s.maxdisk);
        var lit = Math.max(1, Math.round(f * lampCols));
        for (var c = 0; c < lampCols; c++) bars.push(c < lit ? fillLamp(f, 0.8, 0.9) : DARK);
      });
      racks.push({
        label: "LOCAL",
        clock: { kind: "local" },
        lamps: lamps(bars),
        meters: nodeMeters(function (n) {
          return fraction(n.disk, n.maxdisk);
        }),
        scope: scoped("disk", 10 * KB),
      });
      // The right corner, by the nodes' board: the latest tasks.
      racks.push({
        label: "GMT",
        clock: { kind: "gmt" },
        lamps: lamps(
          (tasks || []).map(function (task) {
            return typeof task.end !== "number" ? AMBER : task.status === "OK" ? GREEN : RED;
          }),
        ),
        // A quarter of a node's time spent waiting on its disks is the
        // top of the scale.
        meters: nodeMeters(function (n) {
          return typeof n.wait === "number" ? clamp01(n.wait * 4) : null;
        }),
        scope: scoped("load", 0.25),
      });
      // Along the side walls: a rack to each node, and where the nodes run
      // out, the guests that have been up longest and least.
      var byUptime = guests.filter(running).sort(function (a, b) {
        return b.uptime - a.uptime;
      });
      var spare = [
        {
          guest: byUptime[0],
          lamp: function (g) {
            return running(g) && g.maxdisk > 0 && g.disk > 0 ? fillLamp(fraction(g.disk, g.maxdisk), 0.8, 0.9) : DARK;
          },
          scope: ["netin", 10 * KB],
        },
        {
          guest: byUptime.length > 1 ? byUptime[byUptime.length - 1] : undefined,
          lamp: function (g) {
            var a = activity(guestRate[g.vmid].net);
            return a <= 0 ? DARK : a > 0.6 ? AMBER : GREEN;
          },
          scope: ["netout", 10 * KB],
        },
        {
          guest: byUptime[1],
          lamp: function (g) {
            var a = activity(guestRate[g.vmid].disk);
            return a <= 0 ? DARK : a > 0.6 ? AMBER : GREEN;
          },
          scope: ["write", 10 * KB],
        },
      ];
      for (var k = 0; racks.length < RACKS; k++) {
        var node = nodes[k];
        if (node) {
          var here = guests.filter(function (g) {
            return g.node === node.node;
          });
          racks.push({
            label: node.node.toUpperCase() + " UP D:H:M",
            clock: online(node) ? { seconds: node.uptime || 0, ticking: true, form: "dhm" } : { seconds: null },
            lamps: lamps(here.map(cpuLamp)),
            // The load over one, five and fifteen minutes, against the
            // node's cores.
            meters: [0, 1, 2].map(function (i) {
              return online(node) && node.loadavg && node.maxcpu ? clamp01(node.loadavg[i] / node.maxcpu) : null;
            }),
            scope: scoped("node:" + node.node, 0.05),
          });
        } else {
          var s = spare[(k - nodes.length) % spare.length];
          racks.push({
            label: s.guest ? String(s.guest.name).toUpperCase().slice(0, 10) + " UP D:H:M" : "GUEST UP D:H:M",
            clock: s.guest ? { seconds: s.guest.uptime || 0, ticking: true, form: "dhm" } : { seconds: null },
            lamps: lamps(guests.map(s.lamp)),
            meters: [up.length ? cpu : null, up.length ? memory : null, stores.length ? fraction(stored, storeRoom) : null],
            scope: scoped(s.scope[0], s.scope[1]),
          });
        }
      }

      // --- the cabinets ------------------------------------------------------
      // The first follow the nodes' processors, as they always have; the
      // next their guests' disks, then their networks; and what is left
      // the busiest guests, one each.
      var machines = [];
      nodes.forEach(function (n) {
        machines.push(online(n) ? n.cpu || 0 : -1);
      });
      ["disk", "net"].forEach(function (what) {
        nodes.forEach(function (n) {
          machines.push(online(n) ? activity((byNode[n.node] || {})[what] || 0) : -1);
        });
      });
      guests
        .filter(running)
        .sort(function (a, b) {
          return b.cpu - a.cpu || a.vmid - b.vmid;
        })
        .forEach(function (g) {
          machines.push(clamp01(g.cpu || 0));
        });
      machines = machines.slice(0, machineCount);
      while (machines.length < machineCount) machines.push(null);

      // --- the signs ---------------------------------------------------------
      // "ok" is lit, "off" dark, "warn" flashes and "fault" is red.
      var runningGuests = guests.filter(running).length;
      var quorate = snap.cluster ? snap.cluster.quorate : null;
      function level(value, warn, fault) {
        return value === null ? "off" : value >= fault ? "fault" : value >= warn ? "warn" : "ok";
      }
      var states = {
        QUORUM: quorate === false ? "fault" : up.length ? "ok" : "off",
        NODES: !nodes.length ? "off" : up.length < nodes.length ? "fault" : "ok",
        GUESTS: runningGuests ? "ok" : "off",
        CPU: up.length
          ? level(
              Math.max.apply(
                null,
                up.map(function (n) {
                  return n.cpu || 0;
                }),
              ),
              0.8,
              0.95,
            )
          : "off",
        MEMORY: up.length
          ? level(
              Math.max.apply(
                null,
                up.map(function (n) {
                  return fraction(n.mem, n.maxmem);
                }),
              ),
              0.85,
              0.95,
            )
          : "off",
        // Lit while swap is in use at all.
        SWAP: swap === null || swap < 0.01 ? "off" : level(swap, 0.5, 0.9),
        "IO WAIT": level(wait, 0.1, 0.3),
        LOAD: up.some(function (n) {
          return n.loadavg;
        })
          ? level(cores ? load / cores : 0, 1, 2)
          : "off",
        STORAGE: !storage || !storage.length ? "off" : storageDown ? "fault" : level(fullest, 0.8, 0.9),
        BACKUP: !lastBackup ? "off" : typeof lastBackup.end !== "number" || lastBackup.status === "OK" ? "ok" : "fault",
        // Lit while a task runs; red when the last one to finish failed.
        TASKS: lastEnded && lastEnded.status !== "OK" ? "fault" : active ? "ok" : "off",
        MIGRATE: migrating ? "ok" : "off",
        NETWORK: rates.netin + rates.netout > KB ? "ok" : "off",
        "DISK IO": rates.read + rates.write > KB ? "ok" : "off",
        // This page's own line to the cluster: a snapshot arrived.
        BRIDGE: "ok",
        // A node that came up in the last ten minutes.
        UPTIME: !up.length
          ? "off"
          : up.some(function (n) {
                return n.uptime < 600;
              })
            ? "warn"
            : "ok",
      };
      // The last sign is red while any other is.
      states.ALARM = Object.keys(states).some(function (word) {
        return states[word] === "fault";
      })
        ? "fault"
        : "off";
      var signs = SIGNS.map(function (word) {
        return { word: word, state: states[word] };
      });

      // --- the status board --------------------------------------------------
      var version = null;
      nodes.forEach(function (n) {
        if (n.version && !version) version = n.version;
      });
      var board = {
        cluster: snap.cluster && snap.cluster.name ? String(snap.cluster.name).toUpperCase() : nodes.length === 1 ? nodes[0].node.toUpperCase() : "",
        summary: [
          quorate === null ? null : quorate ? "QUORUM OK" : "NO QUORUM",
          "NODES " + up.length + "/" + nodes.length,
          "GUESTS " + runningGuests + "/" + guests.length,
          version ? "PVE " + version : null,
        ].filter(Boolean),
        storage: storage
          ? stores
              .slice()
              .sort(function (a, b) {
                return fraction(b.disk, b.maxdisk) - fraction(a.disk, a.maxdisk);
              })
              .map(function (s) {
                var f = fraction(s.disk, s.maxdisk);
                return { name: s.storage, node: s.node || "", used: f, state: s.status && s.status !== "available" ? "fault" : level(f, 0.8, 0.9) };
              })
          : null,
        tasks: tasks
          ? tasks.map(function (task) {
              var ended = typeof task.end === "number";
              return {
                ago: ago(snap.t - (ended ? task.end : task.start)),
                node: task.node,
                what: task.type + (task.id ? " " + task.id : ""),
                state: !ended ? "run" : task.status === "OK" ? "ok" : "fault",
              };
            })
          : null,
      };

      return {
        racks: racks,
        machines: machines,
        signs: signs,
        board: board,
        nodeNames: nodes.map(function (n) {
          return n.node;
        }),
      };
    },
  };
}
