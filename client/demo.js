// A fake cluster, for building and showing the scene without a Proxmox host.
// It hands out the same snapshots the bridge will: the fields are the ones
// Proxmox's GET /cluster/resources returns for nodes and guests, under the
// same names, so the rest of the page never knows which one it is talking to.
//
//   snapshot = { t, nodes: [node], guests: [guest], storage: [storage],
//                tasks: [task] or null, cluster: { name, quorate } or null,
//                time: seconds since midnight on the host's clock, or null }
//   node  = { node, status, cpu, maxcpu, mem, maxmem, disk, maxdisk, uptime,
//             loadavg, wait (0..1 of its time waiting on disks), swap,
//             maxswap, version }; the last five null where not known
//   guest = { vmid, name, type ("lxc" | "qemu"), node, status ("running" |
//             "stopped"), cpu (0..1 of maxcpu), maxcpu, mem, maxmem, disk,
//             maxdisk, netin, netout, diskread, diskwrite (byte counters),
//             uptime (s), tags }
//   storage = { storage, node ("" when shared), shared, kind, status
//             ("available"), disk, maxdisk }
//   task  = { type, id, node, user, start, end, status }, newest first; one
//             still running has a null end and status, a finished one's
//             status is "OK" or what went wrong. Times are on the clock t
//             is on.

var GIB = 1024 * 1024 * 1024;

var NAMES = [
  "pihole", "nginx-proxy", "homeassistant", "jellyfin", "sonarr", "radarr", "prowlarr", "qbittorrent",
  "grafana", "prometheus", "influxdb", "vaultwarden", "nextcloud", "paperless", "immich", "gitea",
  "postgres", "mariadb", "redis", "mosquitto", "zigbee2mqtt", "frigate", "unifi", "wireguard",
  "tailscale", "adguard", "uptime-kuma", "homepage", "authentik", "traefik", "minio", "syncthing",
  "matomo", "minecraft", "velocity", "plantit-queue", "meraki-emulator", "loki", "alloy", "ntfy",
  "changedetect", "mealie", "actual", "stirling-pdf", "docker-host", "build-runner",
];
var VM_NAMES = ["win11-lab", "truenas"];

// Small seeded generator (mulberry32), so a demo and its tests are repeatable.
function rng(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function createDemoSource(options) {
  var opts = options || {};
  var count = opts.guests === undefined ? 48 : opts.guests;
  var stopped = opts.stopped === undefined ? 3 : opts.stopped;
  var nodeCount = Math.max(1, opts.nodes === undefined ? 3 : opts.nodes);
  var intervalMs = opts.intervalMs || 2000;
  var random = rng(opts.seed === undefined ? 220 : opts.seed);
  var listeners = [];
  var timer = null;
  var t = 0;

  var guests = [];
  for (var i = 0; i < count; i++) {
    var isVm = i >= count - Math.min(VM_NAMES.length, count);
    var cores = isVm ? 4 : [1, 2, 2, 4][Math.floor(random() * 4)];
    var maxmem = (isVm ? 8 : [0.5, 1, 2, 4][Math.floor(random() * 4)]) * GIB;
    var maxdisk = (isVm ? 64 : [4, 8, 16, 32][Math.floor(random() * 4)]) * GIB;
    var name = isVm ? VM_NAMES[i - (count - VM_NAMES.length)] : NAMES[i % NAMES.length] + (i >= NAMES.length ? "-" + (1 + Math.floor(i / NAMES.length)) : "");
    guests.push({
      vmid: (isVm ? 900 : 100) + (isVm ? i - (count - VM_NAMES.length) : i),
      name: name,
      type: isVm ? "qemu" : "lxc",
      node: "pve" + (1 + (i % nodeCount)),
      status: "running",
      maxcpu: cores,
      maxmem: maxmem,
      maxdisk: maxdisk,
      tags: isVm ? "vm" : "",
      // What the load wanders around, and how far.
      baseCpu: 0.01 + random() * random() * 0.35,
      baseMem: 0.2 + random() * 0.6,
      cpu: 0,
      mem: 0,
      disk: Math.floor(maxdisk * (0.15 + random() * 0.6)),
      netin: Math.floor(random() * 5e9),
      netout: Math.floor(random() * 5e9),
      diskread: Math.floor(random() * 2e10),
      diskwrite: Math.floor(random() * 8e9),
      uptime: Math.floor(3600 + random() * 40 * 86400),
      rate: 2e3 + random() * random() * 4e6,
    });
  }
  // The last few containers start out stopped.
  var offs = 0;
  for (var j = guests.length - 1; j >= 0 && offs < stopped; j--) {
    if (guests[j].type !== "lxc") continue;
    setStatus(guests[j], "stopped");
    offs++;
  }

  var nodes = [];
  for (var n = 0; n < nodeCount; n++) {
    nodes.push({
      node: "pve" + (n + 1),
      status: "online",
      cpu: 0.1,
      maxcpu: 16,
      mem: 0,
      maxmem: 64 * GIB,
      disk: (120 + 30 * n) * GIB,
      maxdisk: 480 * GIB,
      uptime: (61 - 9 * n) * 86400 + 4000 * (n + 1),
      loadavg: [1.2, 1.0, 0.9],
      wait: 0.01,
      swap: Math.floor((0.2 + 0.5 * n) * GIB),
      maxswap: 8 * GIB,
      version: "9.0.3",
    });
  }

  // Each node's own disks, and one store they all share for backups.
  var storage = [];
  for (var s = 0; s < nodeCount; s++) {
    storage.push({ storage: "local", node: "pve" + (s + 1), shared: false, kind: "dir", status: "available", disk: (38 + 17 * s) * GIB, maxdisk: 94 * GIB });
    storage.push({ storage: "local-zfs", node: "pve" + (s + 1), shared: false, kind: "zfspool", status: "available", disk: (120 + 30 * s) * GIB, maxdisk: 480 * GIB });
  }
  storage.push({ storage: "backups", node: "", shared: true, kind: "pbs", status: "available", disk: 2950 * GIB, maxdisk: 3600 * GIB });

  // What has been done lately, newest first: last night's backup, and a
  // few guests started and stopped since, one of which would not start.
  var tasks = [
    { type: "vzstart", id: "104", node: "pve" + (1 + (4 % nodeCount)), user: "root@pam", start: -2400, end: -2397, status: "OK" },
    { type: "qmstart", id: "900", node: "pve1", user: "root@pam", start: -9000, end: -8999, status: "start failed: no such logical volume" },
    { type: "aptupdate", id: "", node: "pve1", user: "root@pam", start: -14400, end: -14370, status: "OK" },
    { type: "vzdump", id: "", node: "pve1", user: "root@pam", start: -26460, end: -25200, status: "OK" },
  ];
  function task(type, id, node, lasts) {
    tasks.unshift({ type: type, id: String(id), node: node, user: "root@pam", start: t, end: null, status: null, until: t + lasts });
    if (tasks.length > 60) tasks.pop();
  }

  // A stopped guest uses nothing; one just started has yet to.
  function setStatus(g, status) {
    g.status = status;
    g.uptime = 0;
    g.cpu = 0;
    g.mem = 0;
  }

  // settling: the first readings, in which nothing happens to any guest.
  function advance(seconds, settling) {
    t += seconds;
    var usedCores = {};
    var usedMem = {};
    for (var i = 0; i < guests.length; i++) {
      var g = guests[i];
      if (g.status !== "running") {
        g.cpu = 0;
        g.mem = 0;
        continue;
      }
      // Load wanders, and now and then something spikes.
      var spike = random() < 0.03 ? 0.3 + random() * 0.6 : 0;
      g.cpu = clamp(g.cpu * 0.6 + (g.baseCpu * (0.5 + random()) + spike) * 0.4, 0.001, 1);
      g.mem = Math.floor(g.maxmem * clamp(g.baseMem + (random() - 0.5) * 0.04, 0.05, 0.98));
      g.netin += Math.floor(g.rate * seconds * (0.3 + random() * 1.4));
      g.netout += Math.floor(g.rate * seconds * 0.4 * (0.3 + random() * 1.4));
      g.diskread += Math.floor(g.rate * seconds * 0.6 * random());
      g.diskwrite += Math.floor(g.rate * seconds * 0.25 * (0.2 + random()));
      g.uptime += seconds;
      usedCores[g.node] = (usedCores[g.node] || 0) + g.cpu * g.maxcpu;
      usedMem[g.node] = (usedMem[g.node] || 0) + g.mem;
    }
    // Every so often a guest is stopped, or a stopped one started, so the
    // wall has something to react to.
    if (!settling && guests.length && random() < seconds / 25) {
      var pick = guests[Math.floor(random() * guests.length)];
      var start = pick.status !== "running";
      setStatus(pick, start ? "running" : "stopped");
      task((pick.type === "qemu" ? "qm" : "vz") + (start ? "start" : "shutdown"), pick.vmid, pick.node, 3);
    }
    // Now and then a guest is backed up, which takes a while.
    if (!settling && guests.length && random() < seconds / 240) {
      var kept = guests[Math.floor(random() * guests.length)];
      task("vzdump", kept.vmid, kept.node, 40 + Math.floor(random() * 60));
    }
    tasks.forEach(function (job) {
      if (job.end === null && t >= job.until) {
        job.end = job.until;
        job.status = "OK";
      }
    });
    nodes.forEach(function (node) {
      node.cpu = clamp((usedCores[node.node] || 0) / node.maxcpu + 0.02, 0, 1);
      node.mem = Math.min(node.maxmem, (usedMem[node.node] || 0) + 6 * GIB);
      node.uptime += seconds;
      node.wait = clamp(node.wait * 0.8 + random() * random() * 0.02, 0, 1);
      var load = node.cpu * node.maxcpu;
      node.loadavg = [
        node.loadavg[0] * 0.7 + load * 0.3,
        node.loadavg[1] * 0.93 + load * 0.07,
        node.loadavg[2] * 0.98 + load * 0.02,
      ];
    });
  }

  // Seconds since midnight; `clock` stands in for the real one in tests.
  function hostTime() {
    if (opts.clock) return opts.clock();
    var now = new Date();
    return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  }

  function snapshot() {
    return {
      t: t,
      nodes: nodes.map(function (node) {
        return {
          node: node.node,
          status: node.status,
          cpu: node.cpu,
          maxcpu: node.maxcpu,
          mem: node.mem,
          maxmem: node.maxmem,
          disk: node.disk,
          maxdisk: node.maxdisk,
          uptime: node.uptime,
          loadavg: node.loadavg.slice(),
          wait: node.wait,
          swap: node.swap,
          maxswap: node.maxswap,
          version: node.version,
        };
      }),
      storage: storage.map(function (store) {
        return { storage: store.storage, node: store.node, shared: store.shared, kind: store.kind, status: store.status, disk: store.disk, maxdisk: store.maxdisk };
      }),
      tasks: tasks.map(function (job) {
        return { type: job.type, id: job.id, node: job.node, user: job.user, start: job.start, end: job.end, status: job.status };
      }),
      cluster: { name: "demo", quorate: true },
      // The demo's host keeps the time of whoever is looking at it.
      time: hostTime(),
      guests: guests.map(function (g) {
        return {
          vmid: g.vmid,
          name: g.name,
          type: g.type,
          node: g.node,
          status: g.status,
          cpu: g.cpu,
          maxcpu: g.maxcpu,
          mem: g.mem,
          maxmem: g.maxmem,
          disk: g.disk,
          maxdisk: g.maxdisk,
          netin: g.netin,
          netout: g.netout,
          diskread: g.diskread,
          diskwrite: g.diskwrite,
          uptime: g.uptime,
          tags: g.tags,
        };
      }),
    };
  }

  function emit() {
    var snap = snapshot();
    listeners.forEach(function (fn) {
      fn(snap);
    });
  }

  advance(0);
  // Settle the first readings so nothing starts at zero.
  for (var k = 0; k < 5; k++) advance(intervalMs / 1000, true);

  return {
    // Calls fn with a snapshot now and after every change.
    subscribe: function (fn) {
      listeners.push(fn);
      fn(snapshot());
      return function () {
        listeners = listeners.filter(function (l) {
          return l !== fn;
        });
      };
    },
    start: function () {
      if (timer) return;
      timer = setInterval(function () {
        advance(intervalMs / 1000);
        emit();
      }, intervalMs);
    },
    stop: function () {
      clearInterval(timer);
      timer = null;
    },
    // Moves the cluster on by hand (tests, and the page's debug handle).
    tick: function (seconds) {
      advance(seconds === undefined ? intervalMs / 1000 : seconds);
      emit();
    },
    // Starts or stops one guest, as the power button will through the bridge.
    setStatus: function (vmid, status) {
      guests.forEach(function (g) {
        if (g.vmid === vmid) setStatus(g, status);
      });
      emit();
    },
    // The power switch, as the bridge has it: a moment later the guest is
    // running or stopped.
    power: function (vmid, action) {
      setTimeout(function () {
        guests.forEach(function (g) {
          if (g.vmid === vmid) setStatus(g, action === "start" ? "running" : "stopped");
        });
        emit();
      }, 900);
      return Promise.resolve({ ok: true });
    },
    snapshot: snapshot,
    // Opens a guest's terminal, as the bridge will: a toy shell here, so
    // the demo can be typed into. handlers: { data(text), note({ ready } |
    // { error } | { closed }) }. Returns { send(text), resize(cols, rows),
    // close() }.
    console: function (vmid, cols, rows, handlers) {
      var guest = null;
      guests.forEach(function (g) {
        if (g.vmid === vmid) guest = g;
      });
      return demoShell(guest, cols, rows, handlers);
    },
  };
}

function demoShell(guest, cols, rows, handlers) {
  var open = true;
  var line = "";
  var escape = 0;
  var prompt = guest ? "root@" + guest.name + ":~# " : "";
  function out(text) {
    if (open) handlers.data(text);
  }
  function hangUp(why) {
    if (!open) return;
    open = false;
    handlers.note({ closed: why });
  }
  // Answered a moment later, as a real one is.
  setTimeout(function () {
    if (!open) return;
    if (!guest) {
      open = false;
      handlers.note({ error: "There is no such guest." });
    } else if (guest.type === "qemu" && guest.name.indexOf("win") === 0) {
      open = false;
      handlers.note({ error: "opening the console: Proxmox answered 500 unable to find a serial interface" });
    } else {
      handlers.note({ ready: true });
      out("\r\nDebian GNU/Linux 13 " + guest.name + " tty1\r\n\r\n(a demo shell: try hostname, uptime, free, echo, clear, exit)\r\n\r\n" + prompt);
    }
  }, 150);

  function run(command) {
    var word = command.split(" ")[0];
    if (command === "") return "";
    if (command === "hostname") return guest.name + "\r\n";
    if (command === "whoami") return "root\r\n";
    if (command === "uname -a") return "Linux " + guest.name + " 6.14.8-2-pve #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux\r\n";
    if (command === "stty size") return rows + " " + cols + "\r\n";
    if (command === "clear") return "\x1b[H\x1b[2J";
    if (command === "uptime") {
      var d = Math.floor(guest.uptime / 86400);
      return " up " + d + " days, load average: " + (guest.cpu * guest.maxcpu).toFixed(2) + "\r\n";
    }
    if (command === "free") {
      var mib = function (b) {
        return String(Math.round(b / 1048576)).padStart(12);
      };
      return "       " + "total".padStart(12) + "used".padStart(12) + "free".padStart(12) + "\r\nMem:   " + mib(guest.maxmem) + mib(guest.mem) + mib(guest.maxmem - guest.mem) + "\r\n";
    }
    if (word === "echo") return command.slice(5) + "\r\n";
    return "-bash: " + word + ": command not found\r\n";
  }

  return {
    send: function (text) {
      if (!open) return;
      var reply = "";
      for (var i = 0; i < text.length; i++) {
        var ch = text[i];
        // An arrow or function key arrives as an escape sequence, which
        // this shell has no use for.
        if (escape) {
          escape = escape === 1 && (ch === "[" || ch === "O") ? 2 : escape === 2 && (ch < "@" || ch > "~") ? 2 : 0;
          continue;
        }
        if (ch === "\x1b") {
          escape = 1;
        } else if (ch === "\r" || ch === "\n") {
          var command = line.trim();
          line = "";
          reply += "\r\n";
          if (command === "exit" || command === "logout") {
            out(reply + "logout\r\n");
            return hangUp("The console closed.");
          }
          reply += run(command) + prompt;
        } else if (ch === "\x7f" || ch === "\b") {
          if (line.length) {
            line = line.slice(0, -1);
            reply += "\b \b";
          }
        } else if (ch === "\x03") {
          line = "";
          reply += "^C\r\n" + prompt;
        } else if (ch === "\x04" && !line) {
          out(reply + "logout\r\n");
          return hangUp("The console closed.");
        } else if (ch >= " ") {
          line += ch;
          reply += ch;
        }
      }
      if (reply) out(reply);
    },
    resize: function (c, r) {
      cols = c;
      rows = r;
    },
    close: function () {
      open = false;
    },
  };
}
