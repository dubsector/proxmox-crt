# proxmox-crt

A security office for your Proxmox host: a wall of CRT monitors, one per VM or
container, a monitor on the desk for each node, and a terminal in front of you
for whichever guest you switch to.

It grows out of [dubsector/terminal](https://github.com/dubsector/terminal),
whose tube shader, character ROM and way of drawing text as a video signal it
reuses.

## Where it stands

This is the grey-box stage: the scene is plain boxes under plain lights, and
the cluster is a made-up one that runs in the page. What works:

- A wall of small monitors, sized to the number of guests (4 x 3, 8 x 3 or
  13 x 4), each showing a guest's number, name, CPU and memory. Spare monitors
  stay off.
- A stopped guest shows OFFLINE. When a guest stops or starts, its monitor
  switches off (the picture folds to a line, then a dot) and warms up again
  with the new picture.
- The desk terminal shows the selected guest in full: gauges, network rates,
  uptime and a CPU history.
- A node monitor on the desk with the host's CPU, memory and guest count.
- Switching: type a monitor number on the numpad (two digits select at once,
  one digit after a pause or Enter), `+` and `-` for next and previous, arrow
  keys to move around the wall, or click a wall monitor.
- Moving the pointer to the bottom of the window looks down at the desk.
  Page Down and Page Up hold either view; Home lets it follow the pointer.

Still to come, in order: the bridge to a real Proxmox host (Rust) and a live
console on the desk terminal, the modelled and baked office, power control,
and a Debian LXC installer.

## Running it

```sh
npm install
npm run dev     # builds on change and serves http://localhost:8086
npm run build   # production build to dist/
npm test
```

Query parameters:

| Parameter | Effect |
|---|---|
| `?hud=1` | Draws every frame and shows the frame rate, monitor count and draw calls. |
| `?guests=N` | Size of the demo cluster (default 48). |
| `?motion=0` | No power-on and view animations, as with the browser's reduced-motion setting. |

## Layout

| Path | What it is |
|---|---|
| `client/main.js` | Page entry: snapshots in, screens out, keys and clicks. |
| `client/scene.js` | The room: wall, desk, camera, picking, the frame loop. |
| `client/gl/face.js` | The tube face shader, in a one-set form and an instanced form. |
| `client/gl/tube.js` | The desk terminal's tube, with its phosphor-state pass. |
| `client/gl/bank.js` | Many small monitors in two draw calls, one array-texture layer each. |
| `client/gl/power.js` | What a tube does when it is switched on and off. |
| `client/gl/textgrid.js` | A grid of characters and the video signal made from it. |
| `client/gl/font9x14.js`, `client/gl/raster.js` | The character ROM and raster geometry, from terminal. |
| `client/cards.js` | What each kind of screen says. |
| `client/select.js` | The switcher's keypad logic. |
| `client/demo.js` | The made-up cluster. Its snapshots use Proxmox's own field names. |
| `test/` | Unit tests for the keypad, the cards and the demo cluster. |
