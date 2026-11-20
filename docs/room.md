# The room and its controls

Everything in the room, and what each key, click and switch does. The short
version is in the [README](../README.md#controls).

- A wall of 13 x 4 small monitors, each showing a guest's number, name, CPU
  and memory. Spare monitors stay off.
- A stopped guest shows OFFLINE. When a guest stops or starts, its monitor
  switches off (the picture folds to a line, then a dot) and warms up again
  with the new picture.
- Selecting a running guest puts its console on the desk terminal, ready to
  type into: the terminal `pct console` gives for a container, the serial
  port for a VM. The last four consoles stay attached, so going back to a
  guest finds its screen as it was. The numpad's `.` flips the desk between
  the console and the guest's figures (gauges, network rates, uptime, CPU
  history).
- A computer room under the wall, right across it: cabinets of
  blinking lamps and tape drives, with tape running from reel to reel. Each
  follows something in the cluster, and blinks and winds as busily as that
  is working: from the left, each node's CPU, then each node's disk traffic,
  then each node's network traffic, and after those the busiest guests, one
  to a cabinet.
- Racks beside the wall, in the corners and along the side walls, as a
  firing room has them, each with a clock, boards of status lamps, three
  meters and a scope. All of it is the cluster's: see
  [What the gear shows](#what-the-gear-shows).
- Two big boards beyond the racks next to the monitors, over more cabinets:
  on the left the cluster's status (its storage, fullest first, and its
  latest tasks), and on the right a plot of each node's CPU over the last
  few minutes. A row of lit signs runs along the top. A wide window shows
  more of all this, and so does turning the view.
- The terminal's keyboard on the desk, whose keys go down and stay down
  while you hold them. Its keys can be clicked too, and type into the
  console on the desk as the real ones would, by what their caps say
  (F11 is Escape, as its cap says). Shift, Ctrl and Compose (Alt) wait for
  the key clicked next, Lock stays on until it is clicked again, and the
  numpad is the switcher's, as yours is. A
  lava lamp; and what a shift leaves lying about: a logbook and pen, a mug
  and a desk lamp, which is terminal's own. Each lamp has a switch
  in its cord on the desk: click the switch to turn it on or off. The lava
  lamp's light goes out at once, but its wax goes by its heat: it sinks and settles over a couple of minutes, and takes a minute to
  get going again.
- A console of small node monitors between the terminal and its keyboard,
  one per node (up to four), with each node's CPU, memory and guest count.
  The console holds three sets; with fewer nodes the spare ones stay dark,
  and a fourth node makes all of them smaller. They come into view when you
  look down at the desk; nothing selects them.
- The switcher on the desk: a box beside the terminal with a two-digit
  readout of the selected monitor and a lamp for that guest's power (green
  running, red stopped); a keypad that can be clicked and whose keys go down as the real
  numpad is typed; and a dial beside the keypad, turned by clicking either half of
  it or with the mouse wheel over it, that steps to the next or previous monitor.
  They are to the right of the terminal.
- The mouse wheel over the desk terminal's screen scrolls back through what
  the console printed (1000 lines); in a pager or an editor it sends the
  arrow keys.
- Copy and paste: drag across the desk terminal's screen to select text, and
  letting go copies it (Ctrl+Shift+C copies it again). Ctrl+V pastes into the
  guest.
- Power: the switcher box has a guarded switch for the selected guest. Click
  the red cover (or press numpad `*`) to lift it, and the readout says what
  the switch will do. Then click the switch (or press numpad Enter) to start
  a stopped guest or shut down a running one; numpad `/` cuts a running
  guest's power instead. Clicking the cover again, or numpad `*`, shuts it
  with nothing done, and so does leaving it for six seconds, selecting
  another monitor or typing a monitor number: Enter after a digit selects,
  and never switches.
- Zoom: the mouse wheel closes in on whatever is under the pointer and backs
  off again, anywhere but over the desk terminal's screen and the dial. It
  stays closed in while monitors are picked.
- Lock: Scroll Lock, numpad `/` or a click on the terminal's case brings the
  view in close to the terminal's screen and holds it still; the same again
  lets go, and so does a right click.
- Power: the push button under the desk terminal's screen switches the
  terminal off and on, as a real monitor's does: the picture folds to a line
  and a fading dot, and comes back after the tube warms up. The green lamp
  beside it shows when it is on. Only the picture goes; the console behind
  it keeps running and keeps taking keys.
- Switching: type a monitor number on the numpad (two digits select at once,
  one digit after a pause or Enter), `+` and `-` for next and previous, or
  click a wall monitor. The numpad always belongs to the switcher; every
  other key goes to the guest while its console is on the desk. With no
  console there, the arrow keys move around the wall.
- Looking around: the view follows the pointer. It turns toward wherever in
  the window the pointer is, a little near the middle and more toward the
  edges, so the wall, the desk and the side walls are all within reach with
  nothing held down. It stops where the room's furnishing ends, and turns
  further the more it is closed in. A right click holds the view where it is, and another
  lets it follow again. Double-click on nothing in particular to go back to
  the seat's view with nothing closed in on. On a touch screen a finger
  drags the view and a tap picks. With no console on the desk, Page Down
  holds the view on the keyboard and Page Up or Home lets it go.
- A second step after the password: the six-digit code of an authenticator
  app, or one of ten recovery codes when the phone is gone, or a passkey
  kept by a phone, a computer or a security key. A small "Sign-in settings"
  button in the bottom left corner, faint until the pointer is on it, opens
  a card where the app is set up (a QR code to scan, or the secret to type
  by hand), removed again, new recovery codes are made, passkeys are added
  and removed, and where you log out. While a card is up, nothing typed
  reaches a guest and the touch keypad is out of reach under it; Escape
  closes the card.
- Single sign-on as a further way in, or the only one: with an OpenID
  Connect provider in the bridge's settings, the log-in card has a button
  that goes to the provider and comes back signed in, for the accounts the
  settings list. The sign-in settings card says whether it is on and
  through whom.

## What the gear shows

Nothing in the room is made up. Whatever the bridge's API token may not read
is shown as not known: a dark lamp, a needle at rest, dashes on a clock.

| Where | Clock | Lamps | Meters | Scope |
| --- | --- | --- | --- | --- |
| Rack left of the monitors | The time of day on the Proxmox host, by its own clock and time zone | One per guest, in the wall's order: green running, amber at 80% CPU or more, red stopped | Each node's CPU | The cluster's CPU |
| Rack right of the monitors | Time since the last backup finished | One per guest: its memory, amber from 75%, red from 90% | Each node's memory | Network traffic, in and out |
| Left corner rack | Local time | A row per storage, lit as far as it is full; amber from 80%, red from 90% | Each node's root disk | Disk traffic, read and written |
| Right corner rack | GMT | One per task, newest first: green done, amber running, red failed | Each node's I/O wait (full scale is 25%) | Load average against cores |
| Side wall racks, one per node | The node's uptime, as days, hours, minutes | That node's guests | Its load over 1, 5 and 15 minutes, against its cores | Its CPU |

With fewer than four nodes, the side racks left over take a guest's uptime
(the longest up, the latest started), and show the guests' disk fill,
network traffic or disk traffic, with meters for the cluster's CPU, memory
and storage. A scope fills its screen with the largest reading on it, so it
shows the shape of the last few minutes, not a scale. Its beam scans
across the screen every four seconds, as an old heart monitor's does: a
bright spot that wipes a small gap ahead of itself and draws the trace as it
goes, brightest where it has just been and fading behind. A clock stops at 99 of
its largest unit.

The signs along the top, left to right. A lit sign is amber, a warning
flashes, a fault is red:

| Sign | Lit | Flashing | Red |
| --- | --- | --- | --- |
| QUORUM | The cluster has quorum (or the host is in no cluster) | | Quorum is lost |
| NODES | Every node is online | | A node is offline |
| GUESTS | A guest is running | | |
| CPU | | A node is at 80% | A node is at 95% |
| MEMORY | | A node is at 85% | A node is at 95% |
| SWAP | Swap is in use | A node's is half full | A node's is 90% full |
| IO WAIT | | A node waits 10% of its time on disks | 30% |
| LOAD | | A minute's load is over the cores there are | Over twice that |
| STORAGE | | A storage is 80% full | 90% full, or not available |
| BACKUP | The latest backup finished well, or is running | | It failed |
| TASKS | A task is running | | The last task to finish failed |
| MIGRATE | A guest is being migrated | | |
| NETWORK | Guests are sending or receiving | | |
| DISK IO | Guests are reading or writing | | |
| BRIDGE | Readings are arriving | | |
| UPTIME | | A node came up in the last ten minutes | |
| ALARM | | | Any other sign is red |

CPU, MEMORY, IO WAIT, LOAD and STORAGE are lit steadily while all is well.
