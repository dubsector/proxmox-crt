# Office build scripts

These model the security office and bake its light with Blender 5.2 running
headless. Nothing here ships; the outputs land in `client/assets/`, which
`build.mjs` copies into `dist/assets/` under content-hashed names. With no
assets the page draws its grey-box room instead.

    blender -b --factory-startup --python tools/blender/build_office.py -- [flags]

The terminal, keyboard, desk lamp and mug and all of the bake machinery come
from [dubsector/terminal](https://github.com/dubsector/terminal)'s
`tools/blender`: `vt_common.py`, `vt_terminal.py`, `vt_keyboard.py` and
`vt_room.py` are copied as they are, and `bake_lib.py` is its
`build_scene.py` without that scene's own assembly. Its README explains the
lightmap layout, the grain filter, the encoding and the visibility trim;
everything there holds here except where this file says otherwise.

## Layout

`layout.json` is `client/layout.js` written out by

    node tools/office-layout.mjs > tools/blender/layout.json

Run it after any change to `client/layout.js`. Every position the page uses
for a live part and the model uses for the surface behind it comes from that
one file, so the two cannot drift apart.

The layout is in the page's tube units (`TUBE_UNIT`, 60.96 mm): the desk
terminal's tube centre at the origin, +Y up, +Z toward the viewer.
`vt_office.P()` turns that into Blender's metres (Z up, viewer at -Y) with
the page's origin on the terminal's `TubeRef` empty and the axes not turned,
so the desk top is z = 0 and the page's `DESK_Y` is -2.739 (the terminal's
tube centre stands 166.97 mm above its desk).

## What is modelled

Only what neither moves nor lights up: the room's shell and ceiling lights,
the rack of the monitor wall and every set's case, the cabinets under the
wall, the racks, the big boards' frames and the signs' housing, the desk,
the node monitors' console and its face plate, the switcher box, the keypad's
case, the dial's plate and scale, the lava lamp's metal, the
lamps' cords, the logbook, mug and desk lamp, and terminal's own
terminal and keyboard.

What moves or lights up stays live in three.js, standing just in front of
those surfaces: every tube face, the cabinets' lamps and reels, the racks'
clocks, lamps, meters and scopes, the boards' charts and the signs, the
readout and the power lamp, the cord switches, the lava lamp's glass and wax.

The desk gear's moving parts are modelled and baked too, each as an object of
its own that the page moves about its origin: the keypad's keys, the dial's
knob, the guard over the power switch and the switch's lever, and each node
monitor's case (which the page makes smaller and moves when there are four
nodes). They are never trimmed: a face hidden where the part was baked can
show once it has moved. Each live module keeps its own plain
stand-ins for the static parts in `shell`; the page hides them once the
model is in and keeps them, unseen, to take the clicks they always took.

The wall is always the full 13 x 4 rack: light maps belong to one shape of
room. With fewer guests the spare sets stay switched off.

## Contract with the page (`client/gl/office.js`)

Objects are found by name; custom properties become glTF `extras`.

| Object | Meaning |
|---|---|
| `TubeRef` | As in terminal: the desk terminal's tube space (x right, z up the face, -y out of the screen in Blender; opening x +-2, z +-1.5). The page moves the model, scaled to tube units, so that this empty is at the origin without turning it, and turns its own tube mesh to the empty's rotation (the terminal leans back 12 degrees). |
| `Collar`, `Nameplate`, `PowerButton`, `PowerLED`, ... | Terminal's terminal (see terminal's README). A click on the case locks the view on it. |
| `Keyboard`, `Key_*`, `LegendStrip`, `Kbd_*` | Terminal's keyboard, its keys and legend strip, exactly as in terminal. Keys dip by `travel` when the real key goes down. |
| `Wall_Sets` | The 52 sets' cases. A click on one picks that monitor, by where it lands on the wall. |
| `Lamp_Base`, `Lamp_Arm`, `Lamp_Shade`, `Lamp_ShadeGlow` | Terminal's desk lamp, without its own cord and rocker switch (this desk's lamp has the cord switch drawn by the page). A click switches it. |
| `Node_Set_<n>` | A node monitor's case, with `node_set` = its place from the left. The page draws the tube's face in its opening. |
| `Pad_<code>` | A key of the keypad, with `pad` = the key's code and `travel` (m) it goes down by. |
| `Dial_Knob` | The dial's knob, turned about its vertical. |
| `Switcher_Guard`, `Switcher_Lever` | The power switch's cover, turned about its hinge (the node's x), and the lever under it, about its pivot. |
| `Cam_Seat`, `Cam_Target` | The seat and where it looks. |
| everything else | Static and baked. |

Node properties as in terminal: `atlas` (which atlas the second UV set
addresses), `role` = `led`, `emissive` (with `emissive`, `emissive_radiance`,
`emissive_off`) or `backing`.

A node with `decals` has printing on it, which the page draws
(`client/gl/decals.js`) and multiplies over the baked colour, as it does the
keyboard's legends: a JSON list of `{ cell, span, text, style, w, h }`, the
cell of an 8 x 8 sheet the node's first UV set addresses, how many cells of
the row it takes, and the print's size on the part in millimetres. Style
`key` is a cap's legend; `plate` is an engraved label, white on black.

### Atlases and passes

Three atlases: `hero` (terminal and keyboard), `desk` (the desk and
everything on it) and `room` (the rest). Four light passes, baked into each:

| Pass | Lit by | The page scales it by |
|---|---|---|
| `room` | Rows of ceiling troffers, and stand-ins for the live parts' own glow: the signs, the boards' charts, the cabinets' and racks' lamps | `roomLevel` (1) |
| `lamp` | The desk lamp (terminal's lamp light, moved with the lamp) | the lamp's level, 0 off to 1 on |
| `screen` | The desk terminal's picture: its centre 88% x 84% emitting white at radiance 1 | the picture's linear radiance: phosphor x mean level |
| `wall` | All 52 wall sets' whole openings emitting white at radiance 1 | the wall's mean linear radiance over all 52 sets |

    colour = decode(lm_X_room)   * room_range_X   * roomLevel
           + decode(lm_X_lamp)   * lamp_range_X   * L
           + decode(lm_X_screen) * screen_range_X * E_desk
           + decode(lm_X_wall)   * wall_range_X   * E_wall

Files: `office.glb` and `lm_<atlas>_<pass>_<N>.webp` for every atlas, pass
and size. Scene extras: `<pass>_range_<atlas>` for each, `tube_unit`,
`lightmap_size`, `lightmap_sizes`, `picture_scale`, `atlases`, `passes` and
`desk_y` (the page refuses a model baked for another desk height).

There is no reflection image yet: the tube's glass keeps its stand-in room.

## Flags

As terminal's `build_scene.py`: `--size`, `--samples`, `--skip-bake`,
`--reuse-unchanged`, `--preview DIR`, `--preview-samples`, `--no-beauty`,
`--out`, `--bake-dir`, `--no-smooth`, `--no-export`, `--blend`. The default
output is `client/assets`.

Quick look on any machine, a CPU included (a few minutes):

    --size 512 --samples 4 --no-beauty --preview <dir> --out <scratch dir>

`vt_office.py` run on its own renders three path-traced views of the room
as lit (`-- --preview <dir> [--samples N]`), which is the quickest way to
judge a change to the model or its lights.
