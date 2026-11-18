// The real cluster, by way of the bridge that serves this page. It hands
// out the same snapshots the demo does (see demo.js), and guests' terminals.
//
// The bridge speaks JSON over /api: state, setup, login, logout; and two
// websockets: /api/feed (a reading of the cluster each time one is taken)
// and /api/console/<vmid> (binary: what is typed and printed; text: notes).

var RETRY_MS = 2000;

function wsUrl(path) {
  return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + path;
}

// Asks whether a bridge is serving this page. Resolves to its state ({
// configured, authed, version }), or null where there is none: a static
// copy of the page, which then shows the demo cluster.
export function findBridge() {
  return fetch("api/state", { cache: "no-store", credentials: "same-origin" })
    .then(function (response) {
      if (!response.ok) return null;
      return response.json();
    })
    .then(function (state) {
      return state && typeof state.configured === "boolean" ? state : null;
    })
    .catch(function () {
      return null;
    });
}

// POSTs JSON to the bridge. Resolves to { ok, status, body }, where a
// failure's body has an `error` to show.
export function ask(path, body) {
  return fetch("api/" + path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  })
    .then(function (response) {
      return response
        .json()
        .catch(function () {
          return {};
        })
        .then(function (json) {
          return { ok: response.ok, status: response.status, body: json || {} };
        });
    })
    .catch(function () {
      return { ok: false, status: 0, body: { error: "The bridge did not answer." } };
    });
}

// options: { onLink(text or ""): the feed's trouble, or its end,
//            onLocked(): the session ran out and the page has to log in }
export function createBridgeSource(options) {
  var opts = options || {};
  var listeners = [];
  var last = null;
  var socket = null;
  var wanted = false;
  var retry = null;

  function link(text) {
    if (opts.onLink) opts.onLink(text);
  }

  function open() {
    if (!wanted || socket) return;
    var ws = (socket = new WebSocket(wsUrl("/api/feed")));
    var opened = false;
    ws.onopen = function () {
      opened = true;
    };
    ws.onmessage = function (ev) {
      var message;
      try {
        message = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (message.snapshot) {
        last = message.snapshot;
        link("");
        listeners.forEach(function (fn) {
          fn(last);
        });
      } else if (message.error) {
        link(message.error);
      }
    };
    ws.onclose = function () {
      if (socket !== ws) return;
      socket = null;
      if (!wanted) return;
      link("The bridge is not answering.");
      // A socket refused outright may mean the session ran out, which a
      // websocket cannot say: ask.
      if (!opened) {
        findBridge().then(function (state) {
          if (state && !state.authed && opts.onLocked) {
            wanted = false;
            opts.onLocked();
          }
        });
      }
      clearTimeout(retry);
      retry = setTimeout(open, RETRY_MS);
    };
  }

  return {
    subscribe: function (fn) {
      listeners.push(fn);
      if (last) fn(last);
      return function () {
        listeners = listeners.filter(function (l) {
          return l !== fn;
        });
      };
    },
    start: function () {
      wanted = true;
      open();
    },
    stop: function () {
      wanted = false;
      clearTimeout(retry);
      if (socket) socket.close();
      socket = null;
    },
    // Opens a guest's terminal. Same contract as the demo's.
    console: function (vmid, cols, rows, handlers) {
      var ws = new WebSocket(wsUrl("/api/console/" + vmid + "?cols=" + cols + "&rows=" + rows));
      var encoder = new TextEncoder();
      var decoder = new TextDecoder("utf-8");
      var done = false;
      ws.binaryType = "arraybuffer";
      function note(n) {
        if (done) return;
        if (n.error || n.closed) done = true;
        handlers.note(n);
      }
      ws.onmessage = function (ev) {
        if (typeof ev.data === "string") {
          try {
            note(JSON.parse(ev.data));
          } catch (e) {
            // Not a note the page knows.
          }
        } else if (!done) {
          // A character can be split between two messages.
          handlers.data(decoder.decode(ev.data, { stream: true }));
        }
      };
      ws.onclose = function () {
        note({ closed: "The console closed." });
      };
      return {
        send: function (text) {
          if (ws.readyState === 1) ws.send(encoder.encode(text));
        },
        // Bytes that are not text (a mouse report above column 95).
        sendBytes: function (binary) {
          if (ws.readyState !== 1) return;
          var bytes = new Uint8Array(binary.length);
          for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 255;
          ws.send(bytes);
        },
        resize: function (c, r) {
          if (ws.readyState === 1) ws.send(JSON.stringify({ resize: [c, r] }));
        },
        close: function () {
          done = true;
          ws.close();
        },
      };
    },
  };
}
