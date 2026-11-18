// Guests' terminals. Each open console is an xterm.js terminal nobody
// sees: it takes the keystrokes and keeps the screen, and the desk tube
// draws that screen from its buffer (as dubsector/terminal does). The last
// few stay attached, so going back to a guest finds its screen as it was.
import { Terminal } from "@xterm/xterm";
import { BOLD, DIM, INVERSE, UNDERLINE } from "./gl/textgrid.js";

var NO_SERIAL = /serial interface/i;

// Breaks a sentence into lines no longer than `width`.
export function wrap(text, width) {
  var out = [];
  var line = "";
  String(text)
    .split(/\s+/)
    .forEach(function (word) {
      while (word.length > width) {
        if (line) out.push(line);
        line = "";
        out.push(word.slice(0, width));
        word = word.slice(width);
      }
      if (line && line.length + 1 + word.length > width) {
        out.push(line);
        line = word;
      } else {
        line = line ? line + " " + word : word;
      }
    });
  if (line) out.push(line);
  return out;
}

// options: { source: has console(vmid, cols, rows, handlers), host: element
// the hidden terminals live in, cols, rows, keep: how many stay attached,
// history: how many lines are kept above the screen,
// reserved(ev): keys the page keeps for itself, onChange(vmid): that
// console's picture changed }
export function createConsoles(options) {
  var source = options.source;
  var cols = options.cols;
  var rows = options.rows;
  var keep = options.keep || 4;
  var sessions = {}; // vmid -> session
  var clock = 0;

  function changed(s) {
    if (sessions[s.vmid] === s && options.onChange) options.onChange(s.vmid);
  }

  function connect(s) {
    s.state = "opening";
    s.message = "";
    var mine = (s.link = source.console(s.vmid, cols, rows, {
      data: function (text) {
        if (s.link !== mine) return;
        s.term.write(text);
      },
      note: function (note) {
        if (s.link !== mine) return;
        if (note.ready) {
          s.state = "live";
          s.term.reset();
          s.back = 0;
          anchor(s);
        } else if (note.error) {
          s.state = "failed";
          s.message = note.error;
        } else if (note.closed) {
          // What it printed last stays on the screen.
          s.state = s.state === "live" ? "closed" : "failed";
          s.message = note.closed;
        }
        changed(s);
      },
    }));
    changed(s);
  }

  // Marks the line at the top of a picture that is showing the history,
  // so that it can be found again once more has been printed.
  function anchor(s) {
    if (s.mark) s.mark.dispose();
    s.mark = null;
    if (!s.back) return;
    var buf = s.term.buffer.active;
    s.mark = s.term.registerMarker(-s.back - buf.cursorY) || null;
  }

  function create(guest) {
    var el = document.createElement("div");
    el.className = "console";
    options.host.appendChild(el);
    var term = new Terminal({ cols: cols, rows: rows, scrollback: options.history === undefined ? 1000 : options.history, cursorBlink: false });
    term.open(el);
    var s = {
      vmid: guest.vmid,
      label: (guest.type === "qemu" ? "VM " : "CT ") + guest.vmid + " " + guest.name,
      term: term,
      el: el,
      state: "opening",
      message: "",
      link: null,
      used: ++clock,
      cursor: true,
      cell: null,
      // Text picked out with the pointer: from one cell to another, in
      // reading order, both included.
      sel: null,
      dragging: false,
      // How many lines back from the newest the screen is showing, and
      // xterm's marker on the line at the top of that picture.
      back: 0,
      mark: null,
    };
    // Whether a program hid the cursor is not in xterm's public state, so
    // watch the sequences that change it. Returning false lets xterm's own
    // handler run as well.
    function cursorMode(final, visible) {
      term.parser.registerCsiHandler({ prefix: "?", final: final }, function (params) {
        for (var i = 0; i < params.length; i++) {
          if (params[i] === 25) s.cursor = visible;
        }
        return false;
      });
    }
    cursorMode("h", true);
    cursorMode("l", false);
    term.attachCustomKeyEventHandler(function (ev) {
      return !(options.reserved && options.reserved(ev));
    });
    term.onData(function (data) {
      // Typing brings the newest lines back.
      if (s.back) {
        s.back = 0;
        anchor(s);
        s.sel = null;
        changed(s);
      }
      if (s.state === "live") s.link.send(data);
      // A console that ended is opened again with Enter.
      else if ((s.state === "closed" || s.state === "failed") && data === "\r") connect(s);
    });
    term.onBinary(function (data) {
      if (s.state === "live" && s.link.sendBytes) s.link.sendBytes(data);
    });
    term.onWriteParsed(function () {
      // What was selected has moved or gone.
      if (!s.dragging) s.sel = null;
      // Lines being read further back stay where they are as more arrive,
      // also once the history is full and its oldest lines are let go. A
      // line that has been let go leaves the oldest one at the top.
      var buf = s.term.buffer.active;
      if (s.back && s.mark && buf.type !== "alternate") s.back = s.mark.line < 0 ? buf.baseY : Math.max(0, buf.baseY - s.mark.line);
      changed(s);
    });
    sessions[guest.vmid] = s;
    connect(s);
    return s;
  }

  function drop(vmid) {
    var s = sessions[vmid];
    if (!s) return;
    delete sessions[vmid];
    if (s.link) s.link.close();
    s.link = null;
    s.term.dispose();
    s.el.remove();
  }

  // Lets go of the consoles used longest ago, beyond the few kept.
  function trim() {
    var all = Object.keys(sessions).map(function (k) {
      return sessions[k];
    });
    all.sort(function (a, b) {
      return b.used - a.used;
    });
    all.slice(keep).forEach(function (s) {
      drop(s.vmid);
    });
  }

  function message(grid, s, heading, body, hint) {
    grid.clear();
    var y = 9;
    grid.put(Math.floor((grid.cols - heading.length) / 2), y, heading, BOLD);
    y += 2;
    wrap(body, grid.cols - 16).forEach(function (line) {
      grid.put(Math.floor((grid.cols - line.length) / 2), y++, line);
    });
    if (hint) {
      y++;
      wrap(hint, grid.cols - 16).forEach(function (line) {
        grid.put(Math.floor((grid.cols - line.length) / 2), y++, line, DIM);
      });
    }
    return grid;
  }

  // A selection as first and last cell indexes, whichever way it was dragged.
  function ordered(sel) {
    if (!sel) return null;
    var a = sel.a.row * cols + sel.a.col;
    var b = sel.b.row * cols + sel.b.col;
    return { from: Math.min(a, b), to: Math.max(a, b) };
  }

  // The selected text: each row without its trailing blanks, and a line
  // the terminal wrapped onto the next row as the one line it was.
  function selected(s) {
    var span = ordered(s.sel);
    if (!span || s.state === "opening" || s.state === "failed") return "";
    var buf = s.term.buffer.active;
    var top = topOf(s);
    var first = Math.floor(span.from / cols);
    var last = Math.floor(span.to / cols);
    var out = "";
    for (var row = first; row <= last; row++) {
      var line = buf.getLine(top + row);
      if (!line) continue;
      var next = buf.getLine(top + row + 1);
      var wraps = row < last && next && next.isWrapped;
      out += line.translateToString(!wraps, row === first ? span.from % cols : 0, row === last ? (span.to % cols) + 1 : cols);
      if (row < last && !wraps) out += "\n";
    }
    return out;
  }

  // The buffer line at the top of the picture: the screen's own first
  // line, or one further back when the wheel has gone up the history.
  function topOf(s) {
    var buf = s.term.buffer.active;
    if (s.back > buf.baseY) s.back = buf.baseY;
    return buf.baseY - s.back;
  }

  function screen(grid, s, blinkOn) {
    var buf = s.term.buffer.active;
    var top = topOf(s);
    var cell = s.cell || (s.cell = buf.getNullCell());
    var w = Math.min(grid.cols, s.term.cols);
    var h = Math.min(grid.rows, s.term.rows);
    grid.clear();
    for (var row = 0; row < h; row++) {
      var line = buf.getLine(top + row);
      if (!line) continue;
      for (var col = 0; col < w; col++) {
        line.getCell(col, cell);
        // The second half of a wide character.
        if (cell.getWidth() === 0) continue;
        var idx = row * grid.cols + col;
        var attr = 0;
        // A monochrome tube has no colours. A coloured background becomes
        // a lit one, or a program's bars and selections would vanish; the
        // grey that programs use for faint text becomes dim.
        if (cell.isBold()) attr |= BOLD;
        else if (cell.isDim() || (cell.isFgPalette() && cell.getFgColor() === 8)) attr |= DIM;
        if (cell.isInverse() || !(cell.isBgDefault() || (cell.isBgPalette() && cell.getBgColor() === 0))) attr |= INVERSE;
        if (cell.isUnderline()) attr |= UNDERLINE;
        grid.chars[idx] = cell.isInvisible() ? " " : cell.getChars() || " ";
        grid.attrs[idx] = attr;
      }
    }
    var span = ordered(s.sel);
    if (span) {
      for (var i = span.from; i <= span.to && i < grid.cols * h; i++) grid.attrs[i] ^= INVERSE;
    }
    if (s.state === "live" && s.cursor && blinkOn && buf.cursorY + s.back < h) {
      // After printing into the last column the cursor waits one past it;
      // draw it on the last column, as xterm does.
      grid.attrs[(buf.cursorY + s.back) * grid.cols + Math.min(buf.cursorX, w - 1)] ^= INVERSE;
    }
    if (s.back) {
      var mark = " " + s.back + " LINES BACK ";
      grid.put(grid.cols - mark.length, 0, mark, INVERSE);
    }
    if (s.state === "closed") {
      var text = " " + s.message + " Press Enter to open it again. ";
      grid.put(0, grid.rows - 1, " ".repeat(grid.cols), INVERSE);
      grid.put(Math.max(0, Math.floor((grid.cols - text.length) / 2)), grid.rows - 1, text, INVERSE);
    }
    return grid;
  }

  return {
    // Attaches the guest's console, or takes up the one already attached.
    open: function (guest) {
      var s = sessions[guest.vmid] || create(guest);
      s.used = ++clock;
      trim();
      return s;
    },
    has: function (vmid) {
      return !!sessions[vmid];
    },
    state: function (vmid) {
      return sessions[vmid] ? sessions[vmid].state : null;
    },
    // Selects from cell `a` to cell `b` ({ col, row }); `dragging` while the
    // pointer is still down, so that output arriving meanwhile leaves it be.
    select: function (vmid, a, b, dragging) {
      var s = sessions[vmid];
      if (!s) return;
      s.sel = a && b ? { a: a, b: b } : null;
      s.dragging = !!dragging && !!s.sel;
      changed(s);
    },
    selection: function (vmid) {
      return sessions[vmid] ? sessions[vmid].sel : null;
    },
    selectedText: function (vmid) {
      return sessions[vmid] ? selected(sessions[vmid]) : "";
    },
    // Moves the picture `lines` up the history (down, if negative). A
    // full-screen program has no history; it is sent the arrow keys
    // instead, as terminals do, so a pager or an editor still scrolls.
    scroll: function (vmid, lines) {
      var s = sessions[vmid];
      if (!s || (s.state !== "live" && s.state !== "closed")) return;
      var buf = s.term.buffer.active;
      if (buf.type === "alternate") {
        if (s.state !== "live") return;
        var key = (s.term.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b[") + (lines > 0 ? "A" : "B");
        s.link.send(key.repeat(Math.abs(lines)));
        return;
      }
      var to = Math.max(0, Math.min(buf.baseY, s.back + lines));
      if (to === s.back) return;
      s.back = to;
      anchor(s);
      s.sel = null;
      s.dragging = false;
      changed(s);
    },
    // Lets one go: its guest stopped or is gone.
    drop: drop,
    // Sends the keyboard to this console.
    focus: function (vmid) {
      var s = sessions[vmid];
      if (s) s.term.focus();
    },
    blur: function () {
      Object.keys(sessions).forEach(function (k) {
        sessions[k].term.blur();
      });
    },
    // Draws the console's picture onto the grid: its screen, or what is
    // keeping it from having one.
    draw: function (vmid, grid, blinkOn) {
      var s = sessions[vmid];
      if (!s) return null;
      if (s.state === "opening") return message(grid, s, "CONNECTING", s.label);
      if (s.state === "failed") {
        return NO_SERIAL.test(s.message)
          ? message(
              grid,
              s,
              "NO TERMINAL",
              s.label + " has no serial port, so there is no text console to show.",
              "Add one in Proxmox (Hardware, Add, Serial Port) and run a getty on it in the guest. Press Enter to try again."
            )
          : message(grid, s, "NO CONSOLE", s.message, "Press Enter to try again.");
      }
      return screen(grid, s, blinkOn);
    },
    count: function () {
      return Object.keys(sessions).length;
    },
    dispose: function () {
      Object.keys(sessions).forEach(function (k) {
        drop(k);
      });
    },
  };
}
