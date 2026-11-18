// The switcher's keypad, as on a CCTV matrix: type a monitor number to route
// it to the desk terminal. Two digits select at once, one digit selects after
// a short pause or on Enter, plus and minus step through the monitors.
//
// Nothing here touches the page: keys come in as KeyboardEvent.code strings
// and the timer is handed in, so the whole thing can be tested on its own.

var DIGIT = /^Numpad([0-9])$/;

export function createKeypad(options) {
  var count = options.count || 0;
  var columns = options.columns || 1;
  var onSelect = options.onSelect;
  var onEntry = options.onEntry || function () {};
  var pauseMs = options.pauseMs === undefined ? 1200 : options.pauseMs;
  var setTimer = options.setTimer || setTimeout;
  var clearTimer = options.clearTimer || clearTimeout;

  var selected = 0; // 1-based monitor number; 0 = nothing selected
  var entry = "";
  var timer = null;

  // How many digits a full number takes: 2 for up to 99 monitors.
  function width() {
    return String(Math.max(count, 1)).length;
  }

  function cancelTimer() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function setEntry(text, bad) {
    entry = text;
    onEntry(entry, !!bad);
  }

  function select(n) {
    if (n < 1 || n > count) return false;
    selected = n;
    onSelect(n);
    return true;
  }

  function commit() {
    cancelTimer();
    if (!entry) return;
    var ok = select(parseInt(entry, 10));
    setEntry("", !ok);
  }

  function step(by) {
    cancelTimer();
    setEntry("");
    if (!count) return;
    var from = selected || (by > 0 ? 0 : 1);
    select(((from - 1 + by + count * 2) % count) + 1);
  }

  // Up and down move by a row and stop at the edges of the wall.
  function row(by) {
    cancelTimer();
    setEntry("");
    var n = (selected || 1) + by * columns;
    if (n >= 1 && n <= count) select(n);
  }

  return {
    // Returns true when the key was the keypad's, so the caller can keep it
    // from doing anything else.
    key: function (code) {
      var m = DIGIT.exec(code);
      if (m) {
        cancelTimer();
        setEntry(entry + m[1]);
        if (entry.length >= width()) commit();
        else timer = setTimer(commit, pauseMs);
        return true;
      }
      switch (code) {
        case "NumpadEnter":
          commit();
          return true;
        case "NumpadAdd":
        case "ArrowRight":
          step(1);
          return true;
        case "NumpadSubtract":
        case "ArrowLeft":
          step(-1);
          return true;
        case "ArrowUp":
          row(-1);
          return true;
        case "ArrowDown":
          row(1);
          return true;
      }
      return false;
    },
    // A click on a wall monitor.
    pick: function (n) {
      cancelTimer();
      setEntry("");
      return select(n);
    },
    // The wall changed size (guests added or removed).
    resize: function (n, cols) {
      count = n;
      if (cols) columns = cols;
      if (selected > count) selected = 0;
    },
    selected: function () {
      return selected;
    },
    entry: function () {
      return entry;
    },
  };
}
