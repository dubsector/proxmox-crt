"""The security office: an Apollo firing room in miniature, round the desk
terminal and keyboard from dubsector/terminal.

    blender -b --factory-startup --python tools/blender/vt_office.py -- --preview <dir>

build(collection, terminal) -> dict of geometry, grouped for the bake
lights(collection)          -> dict of the lights and stand-in emitters of
                               each light pass

Everything is placed from layout.json (written from client/layout.js by
tools/office-layout.mjs), which is in the page's tube units: about 61 mm,
the desk terminal's tube face at the origin facing +Z, +Y up. P() turns a
page point into Blender's metres (Z up, viewer at -Y, desk top z = 0) with
the page's origin on the terminal's TubeRef empty, so the page can line the
two up by that empty alone.

Only what does not move is modelled here. What moves or lights up (screens,
lamps on the cabinets, reels, clocks, meters, keys of the keypad, the dial,
the guard, the cord switches, the lava lamp's glass and wax) stays live in
three.js and stands just in front of the surfaces baked here.
"""
import json
import math
import os
import sys

import bpy
import bmesh
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vt_common as vc  # noqa: E402
import vt_room as vr  # noqa: E402
from vt_room import (Mesh, T, R, p_box, p_cyl, p_lathe, p_tube, p_quad, p_extrude, p_ring, p_disc, rrect, catmull,  # noqa: E402
                     cyl_profile)

U = vc.TUBE_UNIT
with open(os.path.join(HERE, "layout.json")) as _f:
    LAYOUT = json.load(_f)

# Where the page's origin is in Blender: the terminal's TubeRef. Set by
# build() from the terminal that was built; these are its usual values.
ORIGIN = Vector((0.0, 0.0500476, 0.166966))

# Height of the room above the floor (m), and how far the floor and walls
# run toward the viewer past the eye (page z).
ROOM_H = 2.70
FRONT_Z = 30.0

# Lights. The room is lit as a firing room is: low, from rows of ceiling
# troffers, with most of what the eye sees glowing on its own.
TROFFER_COLOR = (0.86, 0.92, 1.0)
# Per row, from the wall forward: the wall row lights the racks and boards,
# the rows over the desk are dimmer so the desk and terminal stay below white.
TROFFER_WATTS = (14.0, 5.0, 5.0)
TROFFER_SIZE = (1.2, 0.3)          # m
# Glow of the live emitters, as stand-ins for the room pass (W/m2/sr-ish
# emission strengths): the signs along the top, the big boards, the lamps
# on the cabinets and racks.
SIGN_GLOW = ((1.0, 0.72, 0.38), 1.6)
BOARD_GLOW = ((0.35, 0.55, 0.8), 0.25)
LAMP_GLOW = ((1.0, 0.56, 0.14), 0.5)


def P(x, y, z):
    """Page point (tube units) to Blender (m)."""
    return Vector((ORIGIN.x + x * U, ORIGIN.y - z * U, ORIGIN.z + y * U))


def S(*size):
    """Page size (tube units) to Blender: x stays x, page y is Blender z,
    page z (depth) is Blender y."""
    if len(size) == 3:
        return (size[0] * U, size[2] * U, size[1] * U)
    return tuple(s * U for s in size)


def turn_m(turn):
    """A turn about the page's Y (radians) as a Blender matrix."""
    return Matrix.Rotation(turn, 4, "Z")


def desk_z():
    return P(0, LAYOUT["deskY"], 0).z


# ---------------------------------------------------------------- materials
def _mat(name, hex_color, roughness=0.6):
    return vc.material(name, vc.srgb(hex_color), roughness)


def materials():
    m = {
        "body": vr._mottled("ConsoleBlue", "#3c4a5a", "#36434f", 30.0, 0.6, 0.35, world=True),
        "panel": _mat("PanelBlack", "#14171a", 0.7),
        "deck": _mat("DeckCream", "#c9c6b6", 0.55),
        "trim": _mat("TrimSteel", "#8f9397", 0.35),
        "rack": _mat("RackCharcoal", "#1d2023", 0.55),
        "bezel": vr._mottled("SetBezel", "#6f706b", "#676863", 60.0, 0.5, 0.4, world=True),
        "recess": _mat("SetRecess", "#141516", 0.6),
        "glass": _mat("SetGlass", "#0c100e", 0.2),
        "plaster": vr._mottled("Plaster", "#3b4046", "#353a40", 2.0, 0.92, 0.6, world=True),
        "floor": vr._mottled("FloorTile", "#2a2b2d", "#202123", 6.0, 0.8, 1.0, world=True, detail=1.0),
        "ceiling": vr._mottled("CeilingTile", "#2e3032", "#292b2d", 8.0, 0.95, 0.6, world=True),
        "troffer": _mat("TrofferFrame", "#b9bab6", 0.4),
        "deskbody": vr._mottled("DeskSteel", "#55606a", "#4f5963", 25.0, 0.5, 0.35, world=True),
        "desktop": vr.wood_material("DeskVeneer", True),
        "rubber": _mat("DeskRubber", "#121314", 0.7),
        "frame": _mat("BoardFrame", "#23272b", 0.45),
        "steel": _mat("SwitcherSteel", "#23272b", 0.45),
        "dark": _mat("ReadoutBlack", "#0b0c0d", 0.35),
        "plate": _mat("PlateSteel", "#2c3035", 0.5),
        "cream": _mat("TickCream", "#d9d3bd", 0.55),
        "hazard": _mat("Hazard", "#d8b21c", 0.55),
        "lava": _mat("LavaMetal", "#b9b4a6", 0.35),
        "cord": _mat("Cord", "#0c0c0c", 0.5),
        "cover": vr._mottled("LogCover", "#2f4a3a", "#2a4234", 400.0, 0.8, 0.6),
        "paper": vr._mottled("LogPaper", "#e6e0cc", "#ddd6c0", 300.0, 0.9, 0.5),
        "ink": _mat("LogInk", "#1f2644", 0.5),
        "black": _mat("HeadsetBlack", "#141516", 0.45),
        "hsteel": _mat("HeadsetSteel", "#9a9995", 0.3),
        "pad": _mat("HeadsetPad", "#1c1a18", 0.85),
        "nodebezel": vr._mottled("NodeBezel", "#5d5f5c", "#565855", 300.0, 0.5, 0.4),
        "faceplate": vr._mottled("FacePlate", "#262a2e", "#22262a", 200.0, 0.4, 0.4),
        "filter": _mat("ReadoutFilter", "#120505", 0.15),
        "guard": _mat("GuardRed", "#b8281a", 0.4),
        "chrome": _mat("LeverChrome", "#b9bcc0", 0.25),
        "knob": _mat("KnobBlack", "#1b1c1e", 0.45),
        "keycream": vr._mottled("PadKeyCream", "#d6d1bd", "#cfcab6", 300.0, 0.5, 0.3),
        "keygrey": vr._mottled("PadKeyGrey", "#8b8a80", "#85847a", 300.0, 0.5, 0.3),
    }
    return m


def _emitter(name, color, strength):
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    mat = vc.material(name, (0.02, 0.02, 0.02), 0.5, emission=color, strength=strength)
    return mat


# ---------------------------------------------------------------- helpers
def box(m, mat, centre, size, bevel=0.0, segs=1, turn=0.0, about=None):
    """A box at a page point, sized in page units, turned about page Y."""
    c = P(*centre)
    piece = p_box(S(*size), bevel * U, segs)
    rot = turn_m(turn)
    if about is not None:
        a = P(*about)
        mat_ = T(*a) @ rot @ T(*(c - a))
    else:
        mat_ = T(*c) @ rot
    m.add(piece, mat, mat_)


def slab_y(m, mat, x0, x1, z0, z1, y, normal_up=True):
    """A horizontal quad (page coordinates)."""
    pts = [P(x0, y, z0), P(x1, y, z0), P(x1, y, z1), P(x0, y, z1)]
    m.add(p_quad(pts, (0, 0, 1 if normal_up else -1)), mat)


# ---------------------------------------------------------------- the room
def _shell(col, mats):
    L = LAYOUT
    side = L["sideWallX"] + L["panel"]["depth"] + 0.3
    back = L["backWallZ"] + 0.5
    floor_y = L["floorY"] + 0.5
    ceil_y = floor_y + ROOM_H / U
    out = {}

    def quad(name, pts, normal, mat):
        return Mesh().add(p_quad(pts, normal), mat).finish(name, col, weighted=False)

    out["Room_Floor"] = quad("Room_Floor", [P(-side, floor_y, back), P(side, floor_y, back), P(side, floor_y, FRONT_Z),
                                           P(-side, floor_y, FRONT_Z)], (0, 0, 1), mats["floor"])
    out["Room_Ceiling"] = quad("Room_Ceiling", [P(-side, ceil_y, back), P(side, ceil_y, back), P(side, ceil_y, FRONT_Z),
                                               P(-side, ceil_y, FRONT_Z)], (0, 0, -1), mats["ceiling"])
    out["Room_BackWall"] = quad("Room_BackWall", [P(-side, floor_y, back), P(side, floor_y, back), P(side, ceil_y, back),
                                                 P(-side, ceil_y, back)], (0, -1, 0), mats["plaster"])
    out["Room_WallLeft"] = quad("Room_WallLeft", [P(-side, floor_y, back), P(-side, floor_y, FRONT_Z),
                                                 P(-side, ceil_y, FRONT_Z), P(-side, ceil_y, back)], (1, 0, 0), mats["plaster"])
    out["Room_WallRight"] = quad("Room_WallRight", [P(side, floor_y, back), P(side, floor_y, FRONT_Z),
                                                   P(side, ceil_y, FRONT_Z), P(side, ceil_y, back)], (-1, 0, 0), mats["plaster"])
    # Skirting along the three walls.
    m = Mesh()
    sh, st = 0.10 / U, 0.016 / U
    box(m, mats["rubber"], (0, floor_y + sh / 2, back + st / 2), (2 * side, sh, st))
    for sx in (-1, 1):
        box(m, mats["rubber"], (sx * (side - st / 2), floor_y + sh / 2, (back + FRONT_Z) / 2), (st, sh, FRONT_Z - back))
    out["Room_Skirting"] = m.finish("Room_Skirting", col)
    # Troffer frames on the ceiling (their light is in lights()).
    m = Mesh()
    for x, z, _row in troffer_spots():
        box(m, mats["troffer"], (x, ceil_y - 0.02 / U, z), (TROFFER_SIZE[0] / U + 0.06 / U, 0.04 / U,
                                                           TROFFER_SIZE[1] / U + 0.06 / U), 0.004 / U)
    out["Room_Troffers"] = m.finish("Room_Troffers", col)
    return out, ceil_y


def troffer_spots():
    L = LAYOUT
    spots = []
    for row, z in enumerate((L["wallZ"] + 8, -10.0, 14.0)):
        for k in range(-4, 5):
            spots.append((k * 26.0, z, row))
    return spots


def _monitor_wall(col, mats):
    """The rack the wall's monitors sit in, its plinth, and the 52 sets'
    cases: a deep bezel round each opening and the body behind it, standing
    out of the rack's face. The page draws each tube face in its opening."""
    L = LAYOUT
    r = L["monitorRack"]
    c = L["cabinet"]
    s = L["wallScale"]
    m = Mesh()
    box(m, mats["rack"], (r["x"], r["y"], r["z"]), (r["w"], r["h"], r["d"]), 0.08, 2)
    # A lip of trim round its face.
    front = r["z"] + r["d"] / 2
    for sy in (-1, 1):
        box(m, mats["trim"], (0, r["y"] + sy * (r["h"] / 2 - 0.1), front + 0.05), (r["w"], 0.2, 0.1), 0.03)
    for sx in (-1, 1):
        box(m, mats["trim"], (sx * (r["w"] / 2 - 0.1), r["y"], front + 0.05), (0.2, r["h"] - 0.4, 0.1), 0.03)
    p = L["plinth"]
    ph = p["top"] - (L["floorY"] + 0.5)
    box(m, mats["rack"], (0, p["top"] - ph / 2, p["z"]), (p["w"], ph, p["d"]), 0.06, 2)
    rack = m.finish("Wall_Rack", col)

    # The sets. Each is modelled in its own tube units (opening x +-2,
    # y +-1.5, face at z = 0) and scaled by the wall's scale.
    sets = Mesh()
    glass = Mesh()
    fw, fh = 2.0, 1.5
    for mon in L["monitors"]:
        def at(x, y, z):
            return (mon["x"] + x * s, mon["y"] + y * s, mon["z"] + z * s)
        # Bezel: four bars round the opening, front at c.front, back at c.seam.
        bd = c["front"] - c["seam"]
        bz = (c["front"] + c["seam"]) / 2
        box(sets, mats["bezel"], at(0, (fh + c["top"]) / 2, bz), ((2 * c["halfW"]) * s, (c["top"] - fh) * s, bd * s), 0.06, 2)
        box(sets, mats["bezel"], at(0, (c["bottom"] - fh) / 2, bz), ((2 * c["halfW"]) * s, (-fh - c["bottom"]) * s, bd * s), 0.06, 2)
        for sx in (-1, 1):
            box(sets, mats["bezel"], at(sx * (fw + c["halfW"]) / 2, 0, bz), ((c["halfW"] - fw) * s, 2 * fh * s, bd * s), 0.04, 1)
        # The dark recess between bezel and glass, and the body behind.
        body_back = (r["z"] + r["d"] / 2 - mon["z"]) / s
        box(sets, mats["recess"], at(0, (c["top"] + c["bottom"]) / 2, (c["seam"] + body_back) / 2),
            (2 * c["halfW"] * s * 0.96, (c["top"] - c["bottom"]) * s * 0.96, (c["seam"] - body_back) * s))
        # The glass stand-in: dark, and the picture's light in the wall pass.
        g = p_box((2 * fw * s * U, 0.002, 2 * fh * s * U))
        glass.add(g, mats["glass"], T(*P(*at(0, 0, 0.02))))
    wall_sets = sets.finish("Wall_Sets", col)
    wall_glass = glass.finish("Wall_GlassProxy", col, weighted=False)
    wall_glass["role"] = "proxy"
    return [rack, wall_sets], wall_glass


def _machines(col, mats):
    """The cabinets under the wall and under the boards: body, the black
    panel behind the lamps and the cream deck behind the reels."""
    M = LAYOUT["machine"]
    floor = LAYOUT["floorY"] + 0.5
    m = Mesh()
    lamps = Mesh()
    for slot in LAYOUT["machines"]:
        h = slot["top"] - floor
        box(m, mats["body"], (slot["x"], slot["top"] - h / 2, slot["z"] - M["depth"] / 2), (M["width"] - 0.2, h, M["depth"]), 0.06, 2)
        # a kick plate at the foot, and a seam between neighbours
        box(m, mats["panel"], (slot["x"], floor + 0.35, slot["z"] + 0.02), (M["width"] - 0.5, 0.7, 0.06), 0.02)
        lw = M["lampCols"] * M["lampPitch"] + 0.5
        lh = M["lampRows"] * M["lampPitch"] + 0.4
        ly = slot["top"] - M["lampsTop"] - (M["lampRows"] * M["lampPitch"]) / 2
        box(m, mats["panel"], (slot["x"], ly, slot["z"] + 0.03), (lw, lh, 0.1), 0.02)
        box(m, mats["trim"], (slot["x"], ly, slot["z"] + 0.005), (lw + 0.16, lh + 0.16, 0.05), 0.02)
        dy = slot["top"] - M["deckTop"] - M["deckHeight"] / 2
        box(m, mats["deck"], (slot["x"], dy, slot["z"] + 0.03), (M["width"] - 0.9, M["deckHeight"], 0.1), 0.03)
        box(m, mats["trim"], (slot["x"], dy, slot["z"] + 0.005), (M["width"] - 0.74, M["deckHeight"] + 0.16, 0.05), 0.02)
        # stand-in for the lamps' glow (room pass)
        lamps.add(p_box(S(lw - 0.4, lh - 0.35, 0.01)), _emitter("LampGlow", *LAMP_GLOW), T(*P(slot["x"], ly, slot["z"] + 0.09)))
    body = m.finish("Machine_Bodies", col)
    glow = lamps.finish("Machine_LampProxy", col, weighted=False)
    glow["role"] = "proxy"
    return body, glow


def _rack(m, mats, rack, glow):
    """One rack of firing-room gear, in the page's frame of `rack`."""
    Pn = LAYOUT["panel"]
    floor = LAYOUT["floorY"] + 0.5
    x, top, z = rack["x"], rack["top"], rack["z"]
    h = top - floor
    box(m, mats["body"], (x, top - h / 2, z - Pn["depth"] / 2), (Pn["width"] - 0.2, h, Pn["depth"]), 0.06, 2)
    box(m, mats["panel"], (x, floor + 0.35, z + 0.02), (Pn["width"] - 0.5, 0.7, 0.06), 0.02)

    def sub(cy, height, width):
        box(m, mats["panel"], (x, cy, z + 0.03), (width, height, 0.1), 0.02)
        box(m, mats["trim"], (x, cy, z + 0.005), (width + 0.16, height + 0.16, 0.05), 0.02)

    pitch = Pn["boardPitchY"]
    bw = Pn["boardCols"] * Pn["boardPitchX"] + 0.4
    sub(top - Pn["clockTop"] - Pn["clockHeight"] / 2, Pn["clockHeight"], Pn["width"] - 0.9)
    by = top - Pn["boardTop"] - Pn["boardRows"] * pitch / 2
    sub(by, Pn["boardRows"] * pitch + 0.4, bw)
    sub(top - Pn["metersTop"] - Pn["meterRadius"], Pn["meterRadius"] * 2 + 0.6, Pn["width"] - 0.9)
    sub(top - Pn["scopeTop"] - Pn["scopeHeight"] / 2, Pn["scopeHeight"] + 0.5, Pn["scopeWidth"] + 0.5)
    ly = top - Pn["lowerTop"] - Pn["lowerRows"] * pitch / 2
    sub(ly, Pn["lowerRows"] * pitch + 0.4, bw)
    for cy, rows in ((by, Pn["boardRows"]), (ly, Pn["lowerRows"])):
        glow.append((x, cy, z + 0.09, bw - 0.4, rows * pitch - 0.2))


def _racks(col, mats):
    m = Mesh()
    glow = []
    for rack in LAYOUT["racks"]:
        _rack(m, mats, rack, glow)
    front = m.finish("Rack_Bodies", col)
    g = Mesh()
    for x, y, z, w, h in glow:
        g.add(p_box(S(w, h, 0.01)), _emitter("LampGlow", *LAMP_GLOW), T(*P(x, y, z)))
    # The side walls' racks, each side in its own turned frame.
    sides = []
    for k, side in enumerate(LAYOUT["sideRacks"]):
        sm = Mesh()
        sglow = []
        for rack in side["racks"]:
            _rack(sm, mats, rack, sglow)
        for x, y, z, w, h in sglow:
            g.add(p_box(S(w, h, 0.01)), _emitter("LampGlow", *LAMP_GLOW),
                  _side_matrix(side) @ T(*(P(x, y, z) - ORIGIN)))
        o = sm.finish("Rack_Side%s" % ("Left" if k == 0 else "Right"), col)
        # sm was built about the page origin; move it into the side's frame
        o.data.transform(_side_matrix(side) @ Matrix.Translation(-ORIGIN))
        sides.append(o)
    glow_obj = g.finish("Rack_LampProxy", col, weighted=False)
    glow_obj["role"] = "proxy"
    return [front] + sides, glow_obj


def _side_matrix(side):
    """The page's group transform of a side wall's racks: at x, turned."""
    return T(*P(side["x"], 0, 0)) @ turn_m(side["turn"])


def _boards(col, mats):
    B = LAYOUT["boards"]
    m = Mesh()
    g = Mesh()
    for at in (B["track"], B["trend"]):
        box(m, mats["frame"], (at["x"], at["y"], at["z"] - 0.25), (at["width"], at["height"], 0.5), 0.05, 2)
        # a cap along the top with a lip
        box(m, mats["trim"], (at["x"], at["y"] + at["height"] / 2 + 0.08, at["z"] - 0.2), (at["width"] + 0.2, 0.16, 0.7), 0.03)
        g.add(p_box(S(at["width"] - 0.8, at["height"] - 0.8, 0.01)), _emitter("BoardGlow", *BOARD_GLOW),
              T(*P(at["x"], at["y"], at["z"] + 0.0)))
    sg = LAYOUT["signs"]
    # The signs' housing: a long lit box along the top of everything.
    box(m, mats["frame"], (0, sg["y"], sg["z"] - 0.3), (sg["width"], sg["height"] + 0.3, 0.6), 0.05, 2)
    g.add(p_box(S(sg["width"] - 0.2, sg["height"] - 0.1, 0.01)), _emitter("SignGlow", *SIGN_GLOW),
          T(*P(0, sg["y"], sg["z"] + 0.0)))
    frames = m.finish("Board_Frames", col)
    glow = g.finish("Board_GlowProxy", col, weighted=False)
    glow["role"] = "proxy"
    return frames, glow


# ---------------------------------------------------------------- the desk
def _desk(col, mats):
    """A long console desk: veneer top with a rounded front edge on a steel
    body with a modesty panel, reaching from the terminal to the floor."""
    D = LAYOUT["desk"]
    y = LAYOUT["deskY"]
    floor = LAYOUT["floorY"] + 0.5
    t = 0.032 / U
    bm = p_box(S(2 * D["halfW"], t, D["front"] - D["back"]))
    front_edges = [e for e in bm.edges
                   if all(v.co.y < -(D["front"] - D["back"]) * U / 2 + 1e-5 for v in e.verts)
                   and abs(e.verts[0].co.x - e.verts[1].co.x) > 0.5]
    bmesh.ops.bevel(bm, geom=front_edges, offset=0.013, segments=5, profile=0.5, affect="EDGES")
    rest = [e for e in bm.edges if len(e.link_faces) == 2 and e.calc_face_angle() > math.radians(60)]
    bmesh.ops.bevel(bm, geom=rest, offset=0.0022, segments=2, profile=0.5, affect="EDGES")
    top = Mesh().add(bm, mats["desktop"], T(*P(0, y - t / 2, (D["front"] + D["back"]) / 2))).finish("Desk_Top", col)

    m = Mesh()
    h = y - t - floor
    cy = floor + h / 2
    # end pedestals with drawers, and a modesty panel set back between them
    for sx in (-1, 1):
        px = sx * (D["halfW"] - 3.2)
        box(m, mats["deskbody"], (px, cy, (D["front"] + D["back"]) / 2 - 0.2), (6.2, h, D["front"] - D["back"] - 0.8), 0.04, 2)
        ty = y - t - 0.15
        for dh in (2.0, 2.0, h - 4.45 - 1.0):
            box(m, mats["deskbody"], (px, ty - dh / 2, D["front"] - 0.55), (5.9, dh - 0.12, 0.12), 0.03)
            box(m, mats["trim"], (px, ty - 0.45, D["front"] - 0.42), (1.8, 0.16, 0.16), 0.05)
            ty -= dh
    box(m, mats["deskbody"], (0, y - t - 5.0, D["back"] + 1.2), (2 * D["halfW"] - 12.4, 10.0, 0.25), 0.03)
    box(m, mats["rubber"], (0, floor + 0.3, D["back"] + 1.2), (2 * D["halfW"] - 12.4, 0.6, 0.3))
    body = m.finish("Desk_Body", col)
    return [top, body]


# ---------------------------------------------------------------- desk gear kit
class Frame:
    """A frame standing on the desk: its origin at a page point, turned about
    the vertical and then pitched about its own x. A part is drawn in it in
    tube units, x to the right, y away from the viewer and z up."""

    def __init__(self, at, turn=0.0, pitch=0.0):
        self.m = T(*P(*at)) @ turn_m(turn) @ Matrix.Rotation(pitch, 4, "X")


# The page prints on some parts (see client/gl/decals.js): the sheet is this
# many cells each way, a print takes one or more cells of a row, and the
# last row stays blank for every face with nothing printed on it.
DECAL_CELLS = 8
DECAL_INSET = 0.03
_decal_next = [0, 0]


def _decal_cells(span):
    col, row = _decal_next
    if col + span > DECAL_CELLS:
        col, row = 0, row + 1
    assert row < DECAL_CELLS - 1, "the decal sheet is full"
    _decal_next[0], _decal_next[1] = col + span, row
    return col, row


class Gear:
    """One object of the desk's gear, built up in a Frame. A part that moves
    keeps the frame as its own transform, so the page can turn or slide it
    about its origin; one that does not is put straight into the room."""

    def __init__(self, frame, moving=False):
        self.mesh = Mesh()
        self.frame = frame
        self.moving = moving
        self.decals = []

    def m(self, local=None):
        base = Matrix.Scale(U, 4) if self.moving else self.frame.m @ Matrix.Scale(U, 4)
        return base @ local if local is not None else base

    def add(self, piece, mat, local=None):
        self.mesh.add(piece, mat, self.m(local))
        return self

    def box(self, mat, centre, size, bevel=0.0, segs=2, rot=None):
        local = T(*centre)
        if rot is not None:
            local = local @ rot
        return self.add(p_box(size, bevel, segs), mat, local)

    def cyl(self, mat, base, r, h, bevel=0.005, segs=24, rot=None):
        local = T(*base)
        if rot is not None:
            local = local @ rot
        return self.add(p_cyl(r, 0.0, h, min(bevel, r * 0.45, h * 0.45), segs), mat, local)

    def decal(self, piece, base_mat, local, size, text, style, span=1):
        """A piece whose faces of material index 1 the page prints `text` on.
        They lie in the piece's own xy plane, `size` across and up, about its
        origin; the print reads along x."""
        col, row = _decal_cells(span)
        name = "Decal_%d_%d" % (col, row)
        mat = bpy.data.materials.get(name)
        if mat is None:
            mat = base_mat.copy()
            mat.name = name
        mats = [base_mat, mat] if any(f.material_index == 0 for f in piece.faces) else [mat, mat]
        m = self.m(local)
        self.mesh.add(piece, mats, m)
        self.decals.append({"mat": name, "m": m.inverted(), "size": size, "cell": (col, row), "span": span,
                            "text": text, "style": style})
        return self

    def plate(self, mat, edge, centre, size, text, rot=None, span=None, style="plate", thick=0.014):
        """An engraved label: a thin plate lying in its own xy plane."""
        local = T(*centre)
        if rot is not None:
            local = local @ rot
        piece = p_box((size[0], size[1], thick), 0.003, 1)
        for f in piece.faces:
            f.material_index = 1 if f.normal.z > 0.9 else 0
        if span is None:
            span = max(1, min(4, int(round(size[0] / size[1] / 1.6))))
        col, row = _decal_cells(span)
        name = "Decal_%d_%d" % (col, row)
        dm = bpy.data.materials.get(name)
        if dm is None:
            dm = mat.copy()
            dm.name = name
        m = self.m(local)
        self.mesh.add(piece, [edge, dm], m)
        self.decals.append({"mat": name, "m": m.inverted(), "size": size, "cell": (col, row), "span": span,
                            "text": text, "style": style})
        return self

    def finish(self, name, col, angle=40.0, weighted=True):
        obj = self.mesh.finish(name, col, angle=angle, weighted=weighted)
        if self.moving:
            obj.matrix_world = self.frame.m
        me = obj.data
        uv = me.uv_layers["UVMap"].data
        blank = (0.5, 0.5 / DECAL_CELLS)
        for loop in me.loops:
            uv[loop.index].uv = blank
        slots = {}
        for d in self.decals:
            slots[me.materials.find(d["mat"])] = d
        for poly in me.polygons:
            d = slots.get(poly.material_index)
            if d is None:
                continue
            w, h = d["size"]
            c, r = d["cell"]
            for li in poly.loop_indices:
                q = d["m"] @ me.vertices[me.loops[li].vertex_index].co
                fx = min(max(q.x / w + 0.5, 0.0), 1.0)
                fy = min(max(0.5 - q.y / h, 0.0), 1.0)
                u = (c + DECAL_INSET + (d["span"] - 2 * DECAL_INSET) * fx) / DECAL_CELLS
                v = (r + DECAL_INSET + (1 - 2 * DECAL_INSET) * fy) / DECAL_CELLS
                uv[li].uv = (u, 1.0 - v)
        if self.decals:
            obj["decals"] = json.dumps([{"cell": d["cell"][0] + d["cell"][1] * DECAL_CELLS, "span": d["span"],
                                         "text": d["text"], "style": d["style"],
                                         "w": round(d["size"][0] * U * 1000, 2), "h": round(d["size"][1] * U * 1000, 2)}
                                        for d in self.decals])
        return obj


def _ring(bm, pts):
    return [bm.verts.new(p) for p in pts]


def _skin(bm, rings, mat=0):
    """Faces between consecutive rings of the same number of points. Rings
    that run counter-clockwise seen from where the next one lies face out."""
    for a, b in zip(rings, rings[1:]):
        n = len(a)
        for j in range(n):
            k = (j + 1) % n
            bm.faces.new((a[j], a[k], b[k], b[j])).material_index = mat


def _fan(bm, ring, centre, mat=0):
    c = bm.verts.new(centre)
    n = len(ring)
    for j in range(n):
        bm.faces.new((ring[j], ring[(j + 1) % n], c)).material_index = mat


def _fillet(pts, radii, n=4):
    """A polygon with its corners rounded: radii[i] at pts[i]."""
    out = []
    count = len(pts)
    for i in range(count):
        p = Vector(pts[i])
        r = radii[i]
        if r <= 0:
            out.append((p.x, p.y))
            continue
        a = (Vector(pts[i - 1]) - p).normalized()
        b = (Vector(pts[(i + 1) % count]) - p).normalized()
        half = a.angle(b) / 2
        d = r / math.tan(half)
        centre = p + (a + b).normalized() * (r / math.sin(half))
        start, end = p + a * d - centre, p + b * d - centre
        a0 = math.atan2(start.y, start.x)
        sweep = math.atan2(end.y, end.x) - a0
        while sweep > math.pi:
            sweep -= 2 * math.pi
        while sweep < -math.pi:
            sweep += 2 * math.pi
        for k in range(n + 1):
            t = a0 + sweep * k / n
            out.append((centre.x + r * math.cos(t), centre.y + r * math.sin(t)))
    return out


def _ccw(poly):
    area = sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1]
               for i in range(len(poly)))
    return poly if area > 0 else list(reversed(poly))


def _screw(g, mat, dark, at, r=0.05, rot=None, slot=0.0):
    """A pan-head screw standing on its own z, with a slot across it."""
    local = T(*at)
    if rot is not None:
        local = local @ rot
    head = p_lathe([(0.0, 0.0), (r, 0.0), (r, r * 0.25), (r * 0.8, r * 0.5), (r * 0.4, r * 0.62), (0.0, r * 0.64)], 14)
    g.add(head, mat, local)
    g.add(p_box((r * 1.7, r * 0.26, r * 0.2)), dark, local @ T(0, 0, r * 0.6) @ Matrix.Rotation(slot, 4, "Z"))


# ---------------------------------------------------------------- the node console
def _glass_z(x, y):
    """How far the tube's face stands out at a point of the opening, in the
    set's own units (client/gl/face.js)."""
    return math.sqrt(121.0 - x * x - y * y) - 11.0 + 0.05


def _node_set(frame, mats, s):
    """One node monitor's case: a moulded bezel standing a little out of the
    console's face plate, its opening running in to the glass the page draws.
    In the set's own units the opening is x +-2, y +-1.5 and the face looks
    along +z; here that is x, z and -y, scaled by `s`."""
    c = LAYOUT["cabinet"]
    g = Gear(frame, moving=True)
    bm = bmesh.new()
    hy = (c["top"] - c["bottom"]) / 2
    mid = (c["top"] + c["bottom"]) / 2
    n = 6

    def ring(hx, hz, r, out, cz=0.0, glass=False):
        pts = []
        for x, y in rrect(hx, hz, r, n):
            y += cz
            z = _glass_z(x, y) + out if glass else out
            pts.append((x * s, -z * s, y * s))
        return _ring(bm, pts)

    hw = c["halfW"]
    front = c["front"]
    rings = [
        ring(hw, hy, 0.30, -0.3, mid),
        ring(hw, hy, 0.30, front - 0.09, mid),
        ring(hw - 0.027, hy - 0.027, 0.28, front - 0.027, mid),
        ring(hw - 0.09, hy - 0.09, 0.24, front, mid),
        ring(2.24, 1.74, 0.50, front),
        ring(2.17, 1.67, 0.46, front - 0.02),
        ring(2.12, 1.62, 0.42, front - 0.07),
        ring(2.0, 1.5, 0.30, 0.03, glass=True),
    ]
    _skin(bm, rings)
    g.add(bm, mats["nodebezel"])
    # The maker's badge on the chin, and a seat for the set's lamp.
    g.box(mats["trim"], (-1.55 * s, -(front + 0.012) * s, -1.86 * s), (0.62 * s, 0.03 * s, 0.14 * s), 0.008 * s)
    g.add(p_ring(0.07 * s, 0.13 * s, 16), mats["dark"],
          T(2.05 * s, -(front + 0.004) * s, -1.85 * s) @ R(90, "X"))
    return g


def _node_console(col, mats):
    """The console the node monitors sit in, between the terminal and its
    keyboard: a wedge of painted steel with a face plate screwed to its
    slope, and the sets standing in a bay of the plate."""
    N = LAYOUT["nodeStrip"]
    c = LAYOUT["cabinet"]
    y0 = LAYOUT["deskY"]
    s = N["scale"]
    lean = N["lean"]
    sets = N["sets"]
    cy = sets[0]["y"] - y0                 # the faces' centres above the desk
    cz = sets[0]["z"]
    cl, sl = math.cos(lean), math.sin(lean)
    BODY, PLATE = -0.06, 0.061             # the wedge's slope and the plate's face, out of the sets' face plane
    bay_lo = c["bottom"] * s - N["bayMargin"]
    bay_hi = c["top"] * s + N["bayMargin"]
    half = N["halfW"]
    lip = 0.035

    def on_slope(u, out):
        """Page (z, height above the desk) of a point u up the slope."""
        return (cz - u * sl + out * cl, cy + u * cl + out * sl)

    u_lo = (lip - cy - BODY * sl) / cl
    u_hi = bay_hi + 0.2
    z_lo, _ = on_slope(u_lo, BODY)
    z_hi, h_hi = on_slope(u_hi, BODY)
    back = z_hi - 0.22
    # The wedge, as its end is seen from the right: (away from the viewer, up).
    prof = _fillet([(-z_lo - 0.0, 0.0), (-z_lo, lip), (-z_hi, h_hi), (-back, h_hi), (-back, 0.0)],
                   [0.0, 0.02, 0.07, 0.09, 0.0], 5)
    g = Gear(Frame((-half, y0, 0.0)))
    body = p_extrude(_ccw(prof), 2 * half, bevel=0.035)
    # extrude's (a, b, c) is the frame's (c, a, b)
    g.add(body, mats["body"], Matrix(((0, 0, 1, 0), (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 0, 1))))
    console = g.finish("Node_Console", col)

    # The face plate, in the slope's own frame: x, y into the console, z up it.
    slope = Frame((0.0, y0 + cy, cz), 0.0, -lean)
    g = Gear(slope)
    bm = bmesh.new()
    p_lo, p_hi = u_lo + 0.035, u_hi - 0.03
    pc, ph = (p_lo + p_hi) / 2, (p_hi - p_lo) / 2
    bc, bh = (bay_lo + bay_hi) / 2, (bay_hi - bay_lo) / 2
    pw, bw = half - 0.04, N["bayHalfW"]

    def ring(hx, hz, r, out, mid):
        return _ring(bm, [(x, -out, z + mid) for x, z in rrect(hx, hz, r, 5)])

    _skin(bm, [
        ring(pw, ph, 0.07, BODY, pc),
        ring(pw, ph, 0.07, PLATE - 0.018, pc),
        ring(pw - 0.018, ph - 0.018, 0.06, PLATE, pc),
        ring(bw + 0.016, bh + 0.016, 0.085, PLATE, bc),
        ring(bw, bh, 0.07, PLATE - 0.016, bc),
        ring(bw, bh, 0.07, BODY, bc),
    ])
    g.add(bm, mats["faceplate"])
    out_rot = R(90, "X")
    for sx in (-1, 1):
        for k, u in enumerate((p_lo + 0.13, p_hi - 0.13)):
            _screw(g, mats["trim"], mats["dark"], (sx * (pw - 0.115), -PLATE, u), 0.042, out_rot, 0.6 + 1.1 * k + sx)
    g.plate(mats["cream"], mats["dark"], (0.0, -PLATE - 0.005, (bay_hi + 0.016 + p_hi - 0.018) / 2), (1.3, 0.075),
            "NODE MONITORS", out_rot, span=4, thick=0.01)
    plate = g.finish("Node_Plate", col)

    # The sets themselves, each on its own so that the page can make room
    # for a fourth.
    out = [console, plate]
    for k, at in enumerate(sets):
        o = _node_set(Frame((at["x"], at["y"], at["z"]), 0.0, -lean), mats, s).finish("Node_Set_%d" % k, col)
        o["node_set"] = k
        out.append(o)
    return out


# ---------------------------------------------------------------- the switcher
SWITCHER = (3.3, 1.9, 2.2)        # width, height, depth (client/gl/controls.js BOX)


def _switcher(col, mats):
    """The switcher box: a steel instrument case on rubber feet, with a
    panel let into its front for the readout's window, the power lamp and
    the guarded switch. The guard and the switch's lever are parts of their
    own, hung where they turn."""
    bx = LAYOUT["controls"]["box"]
    y0 = LAYOUT["deskY"]
    W, H, D = SWITCHER
    fr = Frame((bx["x"], y0, bx["z"]), bx["turn"])
    front = -D / 2
    g = Gear(fr)
    foot = 0.07
    g.box(mats["body"], (0, 0, foot + (H - foot) / 2), (W, D, H - foot), 0.09, 4)
    for sx in (-1, 1):
        for sy in (-1, 1):
            g.cyl(mats["rubber"], (sx * (W / 2 - 0.3), sy * (D / 2 - 0.3), 0.0), 0.16, foot + 0.02, 0.02, 16)
    # The front panel, set a little out of the case's face, with a rolled edge.
    cz = foot + (H - foot) / 2
    pw, phh = W - 0.26, H - foot - 0.26
    g.box(mats["faceplate"], (0, front - 0.012, cz), (pw, 0.05, phh), 0.02, 2)
    out_rot = R(90, "X")
    for sx in (-1, 1):
        for sz in (-1, 1):
            _screw(g, mats["trim"], mats["dark"], (sx * (pw / 2 - 0.1), front - 0.037, cz + sz * (phh / 2 - 0.1)),
                   0.04, out_rot, 0.5 + sx + 0.7 * sz)
    # The readout's window: a bezel standing out round a dark filter.
    wx, wz, ww, wh = -0.42, H / 2 + 0.02, 2.0, 1.45
    bm = bmesh.new()

    def ring(hx, hz, r, out):
        return _ring(bm, [(wx + x, front - out, wz + z) for x, z in rrect(hx, hz, r, 5)])

    _skin(bm, [
        ring(ww / 2 + 0.1, wh / 2 + 0.1, 0.11, 0.03),
        ring(ww / 2 + 0.1, wh / 2 + 0.1, 0.11, 0.085),
        ring(ww / 2 + 0.075, wh / 2 + 0.075, 0.09, 0.105),
        ring(ww / 2 + 0.02, wh / 2 + 0.02, 0.07, 0.105),
        ring(ww / 2 - 0.02, wh / 2 - 0.02, 0.06, 0.04),
    ])
    g.add(bm, mats["plate"])
    g.box(mats["filter"], (wx, front - 0.035, wz), (ww, 0.02, wh))
    # The power lamp's bezel, the switch's plate with its nut, and the
    # hinge the guard hangs from.
    sx_ = 1.12
    lz = H / 2 + 0.62
    g.add(p_lathe([(0.105, 0.0), (0.17, 0.0), (0.17, 0.05), (0.145, 0.075), (0.11, 0.075), (0.105, 0.03)], 24),
          mats["trim"], T(sx_, front - 0.035, lz) @ out_rot)
    g.add(p_disc(0.108, 24), mats["dark"], T(sx_, front - 0.045, lz) @ out_rot)
    pz = H / 2 - 0.3
    g.box(mats["plate"], (sx_, front - 0.045, pz), (0.74, 0.03, 0.8), 0.012, 2)
    for sz in (-1, 1):
        _screw(g, mats["trim"], mats["dark"], (sx_ + 0.27 * sz, front - 0.06, pz - sz * 0.31), 0.03, out_rot, 0.9 * sz)
    hexnut = p_extrude([(0.15 * math.cos(math.pi * k / 3), 0.15 * math.sin(math.pi * k / 3)) for k in range(6)], 0.06,
                       bevel=0.012)
    g.add(hexnut, mats["trim"], T(sx_, front - 0.06, pz) @ out_rot)
    g.cyl(mats["trim"], (sx_, front - 0.12, pz), 0.1, 0.05, 0.01, 16, out_rot)
    hz = H / 2 + 0.1
    for sx in (-1, 1):
        g.box(mats["trim"], (sx_ + sx * 0.33, front - 0.075, hz + 0.02), (0.07, 0.11, 0.16), 0.015, 2)
    g.add(p_cyl(0.035, -0.37, 0.37, 0.008, 12), mats["trim"], T(sx_, front - 0.1, hz + 0.04) @ R(90, "Y"))
    # Cooling ribs along the top, toward the back.
    for k in range(9):
        g.box(mats["body"], (0.0, 0.25 + k * 0.085, H + 0.012), (W - 1.0, 0.045, 0.05), 0.012, 2)
    # Labels, on the top where the seat reads them.
    g.plate(mats["cream"], mats["dark"], (wx, front + 0.3, H + 0.006), (0.95, 0.13), "MONITOR")
    g.plate(mats["cream"], mats["dark"], (sx_, front + 0.3, H + 0.006), (0.8, 0.13), "POWER")
    box_obj = g.finish("Switcher_Box", col)

    # The guard: a red cover over the switch, hinged along its top edge.
    hinge = (sx_, front - 0.1, hz + 0.04)
    gf = Frame((bx["x"], y0, bx["z"]), bx["turn"])
    gf.m = gf.m @ T(*(Vector(hinge) * U))
    g = Gear(gf, moving=True)
    bm = bmesh.new()

    # A cap open toward the panel, hanging from the hinge: x across, y out
    # of the panel (toward the viewer is negative), z up.
    def gring(hx, hz, r, y):
        return _ring(bm, [(x, y, z - 0.39) for x, z in rrect(hx, hz, r, 4)])

    rings = [gring(0.29, 0.39, 0.07, 0.03), gring(0.29, 0.39, 0.07, -0.47), gring(0.275, 0.375, 0.07, -0.51),
             gring(0.22, 0.32, 0.06, -0.53)]
    _skin(bm, rings)
    _fan(bm, rings[-1], (0.0, -0.53, -0.39))
    g.add(bm, mats["guard"])
    # ribs down its front, and a tab at its foot for a finger
    for k in (-1, 0, 1):
        g.box(mats["guard"], (k * 0.13, -0.535, -0.36), (0.04, 0.03, 0.46), 0.01, 2)
    g.box(mats["guard"], (0.0, -0.5, -0.79), (0.3, 0.12, 0.05), 0.015, 2)
    guard = g.finish("Switcher_Guard", col)

    # The lever: a bat handle on its pivot, pointing out of the panel.
    lf = Frame((bx["x"], y0, bx["z"]), bx["turn"])
    lf.m = lf.m @ T(*(Vector((sx_, front - 0.07, pz)) * U))
    g = Gear(lf, moving=True)
    bat = p_lathe([(0.0, 0.0), (0.05, 0.0), (0.045, 0.12), (0.075, 0.38), (0.078, 0.43), (0.06, 0.47), (0.0, 0.485)], 16)
    g.add(bat, mats["chrome"], out_rot)
    lever = g.finish("Switcher_Lever", col)
    return [box_obj, guard, lever]


# ---------------------------------------------------------------- the keypad
def _keycap(w, d, h, taper=0.045, dish=0.022):
    """A key cap standing on z = 0: a skirt that draws in to a dished top.
    The top's faces carry material index 1."""
    bm = bmesh.new()
    hx, hy = w / 2, d / 2
    tx, ty = hx - taper, hy - taper * 0.8
    e = 0.03

    def ring(ax, ay, r, z):
        return _ring(bm, [(x, y + 0.01 * (z / h), z) for x, y in rrect(ax, ay, r, 4)])

    rings = [ring(hx, hy, 0.035, 0.0), ring(hx - 0.004, hy - 0.004, 0.04, h * 0.2),
             ring(tx, ty, 0.06, h - e), ring(tx - e * 0.3, ty - e * 0.3, 0.058, h - e * 0.3)]
    _skin(bm, rings)
    ax, ay = tx - e, ty - e
    top = [rings[-1], ring(ax, ay, 0.05, h)]
    for f in (0.75, 0.5, 0.25):
        top.append(ring(ax * f, ay * f, 0.05 * f, h - dish * (1 - f * f)))
    _skin(bm, top, 1)
    _fan(bm, top[-1], (0.0, 0.01, h - dish), 1)
    return bm


DIAL_RISE = 0.24           # the top of the selector's case, which the dial stands on


def _keypad(col, mats):
    """The selector: one low case with a well for the keypad's keys on the
    left and the dial's scale on the right, and the keys, each a part of
    its own that goes down when it is pressed."""
    kp = LAYOUT["controls"]["keypad"]
    dl = LAYOUT["controls"]["dial"]
    y0 = LAYOUT["deskY"]
    pitch = kp["pitch"]
    half = (4 * pitch + 0.3) / 2
    left, right = kp["x"] - half - 0.3, dl["x"] + 1.1
    mid, hw = (left + right) / 2, (right - left) / 2
    fr = Frame((mid, y0, kp["z"]))
    g = Gear(fr)
    bm = bmesh.new()

    def ring(hx, hy, r, z, cx=0.0):
        return _ring(bm, [(x + cx, y, z) for x, y in rrect(hx, hy, r, 5)])

    well = 2 * pitch + 0.045
    wx = kp["x"] - mid
    top, floor = DIAL_RISE, 0.15
    rings = [ring(hw, half, 0.16, 0.0), ring(hw, half, 0.16, top - 0.05), ring(hw - 0.015, half - 0.015, 0.15, top - 0.015),
             ring(hw - 0.05, half - 0.05, 0.13, top), ring(well + 0.02, well + 0.02, 0.09, top, wx),
             ring(well, well, 0.075, top - 0.02, wx), ring(well, well, 0.075, floor, wx)]
    _skin(bm, rings)
    bm.faces.new(rings[-1])
    g.add(bm, mats["body"])
    # the dial's scale: a raised ring marked every click
    dx = dl["x"] - mid
    g.add(p_lathe([(0.84, top), (1.02, top), (1.02, top + 0.025), (1.0, top + 0.04), (0.86, top + 0.04),
                   (0.84, top + 0.025)], 48), mats["faceplate"], T(dx, 0, 0))
    for k in range(12):
        a = k * math.pi / 6
        g.box(mats["cream"], (dx + math.sin(a) * 0.93, math.cos(a) * 0.93, top + 0.04),
              (0.05 if k % 3 == 0 else 0.035, 0.13, 0.012), 0.0, 1, Matrix.Rotation(-a, 4, "Z"))
    for sy in (-1, 1):
        _screw(g, mats["trim"], mats["dark"], (hw - 0.17, sy * (half - 0.17), top), 0.035, None, 0.8 + sy)
        _screw(g, mats["trim"], mats["dark"], (0.17 - hw, sy * (half - 0.17), top), 0.035, None, 1.9 - sy)
        _screw(g, mats["trim"], mats["dark"], (dx - 1.0, sy * (half - 0.17), top), 0.035, None, 0.3 - sy)
    base = g.finish("Keypad_Case", col)

    out = [base]
    for key in kp["keys"]:
        w = key["w"] * pitch - (pitch - kp["size"])
        d = key["h"] * pitch - (pitch - kp["size"])
        x = (key["col"] + key["w"] / 2 - 2) * pitch
        y = -(key["row"] + key["h"] / 2 - 2) * pitch
        kf = Frame((kp["x"], y0, kp["z"]))
        kf.m = kf.m @ T(x * U, y * U, floor * U)
        g = Gear(kf, moving=True)
        h = 0.25
        cap = _keycap(w, d, h)
        tone = mats["keygrey"] if key["tone"] == "grey" else mats["keycream"]
        g.decal(cap, tone, T(0, 0.008, 0), (w - 0.15, d - 0.13), key["legend"], "key")
        o = g.finish("Pad_" + key["code"], col, angle=50.0)
        o["pad"] = key["code"]
        o["travel"] = 0.07 * U
        out.append(o)
    return out


# ---------------------------------------------------------------- the dial
def _dial(col, mats):
    """The dial's knob, standing on the selector's case: an instrument knob
    with a fluted grip, a skirt and a pointer."""
    dl = LAYOUT["controls"]["dial"]
    y0 = LAYOUT["deskY"]
    kf = Frame((dl["x"], y0 + DIAL_RISE, dl["z"]))
    g = Gear(kf, moving=True)
    # skirt, then the fluted grip, then a cap
    g.add(p_lathe([(0.0, 0.0), (0.8, 0.0), (0.8, 0.035), (0.74, 0.1), (0.6, 0.14), (0.0, 0.14)], 48), mats["knob"])
    bm = bmesh.new()
    flutes = 30
    segs = flutes * 4
    rings = []
    for z, rr in ((0.12, 0.0), (0.16, 0.0), (0.44, 0.012), (0.475, 0.035)):
        pts = []
        for j in range(segs):
            a = 2 * math.pi * j / segs
            r = 0.62 - rr - (0.022 if j % 4 >= 2 else 0.0)
            pts.append((r * math.cos(a), r * math.sin(a), z))
        rings.append(_ring(bm, pts))
    _skin(bm, rings)
    g.add(bm, mats["knob"])
    g.add(p_lathe([(0.0, 0.47), (0.57, 0.47), (0.57, 0.485), (0.54, 0.5), (0.0, 0.5)], 48), mats["trim"])
    # the pointer: a line across the cap to the rim, and down the skirt
    g.box(mats["cream"], (0.0, 0.3, 0.502), (0.05, 0.5, 0.012), 0.0, 1)
    g.box(mats["cream"], (0.0, 0.725, 0.085), (0.05, 0.16, 0.02), 0.0, 1, R(-38, "X"))
    knob = g.finish("Dial_Knob", col, angle=35.0)
    return [knob]


def _controls(col, mats):
    return _switcher(col, mats) + _keypad(col, mats) + _dial(col, mats)


def _lava_lamp(col, mats):
    """The lava lamp's metal: its base, narrowing to a waist and widening to
    hold the glass, and its cap. The glass and wax are the page's."""
    at = LAYOUT["lavaLamp"]
    y = LAYOUT["deskY"]
    base_h, glass_h, cap_h, low, high = 1.0, 2.4, 0.45, 0.52, 0.24
    prof = [(0.0, 0.0), (0.62, 0.0), (0.3, base_h * 0.6), (low + 0.04, base_h), (low - 0.02, base_h), (0.0, base_h)]
    prof = [(r * U, z * U) for r, z in prof]
    m = Mesh().add(p_lathe(prof, 32), mats["lava"], T(*P(at["x"], y, at["z"])))
    top = base_h + glass_h
    cap = [(0.0, top), (high + 0.03, top), (0.12, top + cap_h), (0.0, top + cap_h)]
    m.add(p_lathe([(r * U, z * U) for r, z in cap], 32), mats["lava"], T(*P(at["x"], y, at["z"])))
    return m.finish("Lava_Metal", col, angle=50.0)


def _logbook(col, mats, at, y0):
    """The logbook, open: a cloth cover, two blocks of pages that rise from
    the gutter and fall away to the edges, what was written on them, a
    ribbon and a pen."""
    g = Gear(Frame((at["x"], y0, at["z"]), at["turn"]), moving=True)
    g.box(mats["cover"], (0, 0, 0.035), (3.4, 2.3, 0.07), 0.02, 2)
    depth = 2.1
    prof = [(0.03, 0.07), (1.62, 0.07), (1.62, 0.125), (1.3, 0.148), (0.7, 0.165), (0.3, 0.16), (0.1, 0.135),
            (0.03, 0.1)]
    along_y = Matrix(((1, 0, 0, 0), (0, 0, -1, depth / 2), (0, 1, 0, 0), (0, 0, 0, 1)))
    left = written_page("LogWrittenLeft", (-1.5 * U, -0.2 * U), (-0.92 * U, 0.92 * U), 3.0)
    right = written_page("LogWrittenRight", (0.2 * U, 1.5 * U), (0.1 * U, 0.92 * U), 11.0)
    for side, written in ((-1, left), (1, right)):
        poly = prof if side > 0 else [(-x, z) for x, z in reversed(prof)]
        block = p_extrude(poly, depth, bevel=0.006)
        for f in block.faces:
            f.normal_update()
            # extrude's y is up here
            f.material_index = 1 if f.normal.y > 0.5 else 0
        g.add(block, [mats["paper"], written], along_y)
    g.box(mats["guard"], (0.02, 0.0, 0.118), (0.09, depth, 0.008))
    g.box(mats["guard"], (0.02, -1.36, 0.005), (0.09, 0.36, 0.008))
    # terminal's pen, lying across the right-hand page
    barrel = _mat("LogPenBarrel", "#22407f", 0.35)
    tip = _mat("LogPenTip", "#a88a45", 0.35)
    prof = [(0.0, 0.0), (0.0007, 0.0004), (0.0021, 0.010), (0.0038, 0.0125), (0.0038, 0.101), (0.0046, 0.1015),
            (0.0046, 0.1455), (0.0040, 0.1478), (0.0026, 0.1488), (0.0, 0.1488)]
    lie = T(0.95, -0.25, 0.165 + 0.0046 / U) @ Matrix.Rotation(math.radians(28), 4, "Z") @ Matrix.Scale(1 / U, 4)
    g.add(p_lathe(prof, 12, [0, 0, 1, 1, 1, 1, 1, 1, 1]), [tip, barrel], lie @ R(90, "Y") @ T(0, 0, -0.074))
    g.add(p_box((0.036, 0.0036, 0.0012), 0.0004, 1), barrel, lie @ T(0.053, 0.0, 0.0052))
    return g.finish("Logbook", col)


def written_page(name, u_lim, v_lim, seed):
    return vr.written_material(name, "#e6e0cc", 0, 1, 0.0075, u_lim, v_lim, hex_ink="#1f2644", mottle="#ddd6c0",
                               seed=seed)


def _props(col, mats):
    """A logbook and pen, a mug (terminal's) and the desk lamp
    (terminal's, without its own cord and switch: this desk's lamp has the
    cord switch J asked for, drawn by the page)."""
    pr = LAYOUT["props"]
    y = LAYOUT["deskY"]
    out = []

    out.append(_logbook(col, mats, pr["logbook"], y))

    mug = vr._mug(col)
    mg = pr["mug"]
    mug.location = P(mg["x"], y, mg["z"])
    out.append(mug)

    parts, bulb = vr._lamp(col)
    lp = pr["lamp"]
    keep = []
    for o in parts:
        if o.name in ("Lamp_Cord", "Lamp_Switch", "Lamp_SwitchBody"):
            me = o.data
            bpy.data.objects.remove(o)
            bpy.data.meshes.remove(me)
            continue
        keep.append(o)
    for o in keep + [bulb]:
        o.location = P(lp["x"], y, lp["z"])
        o.rotation_euler = (0, 0, lp["turn"])
    return out, keep, bulb


def _cords(col, mats):
    """The lamps' cords, from each base to its switch and on over the back
    of the desk, as the page's cord switches lie (cordswitch.js)."""
    y = LAYOUT["deskY"]
    BODY_L, BODY_W, SIZE, CORD_R = 0.82, 0.3, 0.6, 0.028
    out = []
    for key, name in (("lava", "Cord_Lava"), ("lamp", "Cord_Lamp")):
        o = LAYOUT["cords"][key]
        tt = o["turn"]
        along = (math.sin(tt), math.cos(tt))
        half = BODY_L / 2 * SIZE
        mid = BODY_W / 2 * SIZE

        def at(x, z, h=None):
            return P(x, y + (CORD_R if h is None else h), z)

        def end(side, out_, h=None):
            return at(o["x"] + along[0] * side * (half + out_), o["z"] + along[1] * side * (half + out_), h)

        lamp_run = [at(p[0], p[1]) for p in o["fromLamp"]]
        lamp_run += [end(-1, 0.45), end(-1, 0.12, mid * 0.8), end(-1, -0.03, mid)]
        wall_run = [end(1, -0.03, mid), end(1, 0.12, mid * 0.8), end(1, 0.45)] + [at(p[0], p[1]) for p in o["toWall"]]
        e = o["toWall"][-1]
        wall_run += [at(e[0], e[1] - 0.12, -0.1), at(e[0], e[1] - 0.16, -1.2), at(e[0], e[1] - 0.16, -6)]
        m = Mesh()
        for run in (lamp_run, wall_run):
            m.add(p_tube(catmull(run, 8), CORD_R * U, 6), mats["cord"])
        out.append(m.finish(name, col, angle=60.0))
    return out


def build(collection, terminal):
    """terminal: the dict vt_terminal.build() returned. Sets ORIGIN from its
    TubeRef so the page and the model share an origin."""
    global ORIGIN
    bpy.context.view_layer.update()
    ORIGIN = terminal["TubeRef"].matrix_world.translation.copy()
    assert abs(ORIGIN.z / U + LAYOUT["deskY"]) < 0.002, (ORIGIN.z / U, LAYOUT["deskY"])
    mats = materials()
    shell, ceil_y = _shell(collection, mats)
    wall_parts, wall_glass = _monitor_wall(collection, mats)
    machines, machine_glow = _machines(collection, mats)
    racks, rack_glow = _racks(collection, mats)
    frames, board_glow = _boards(collection, mats)
    desk = _desk(collection, mats)
    console = _node_console(collection, mats)
    controls = _controls(collection, mats)
    lava = _lava_lamp(collection, mats)
    props, lamp, bulb = _props(collection, mats)
    cords = _cords(collection, mats)

    cams = []
    for name, loc in (("Cam_Seat", P(0, 2.8, 9)), ("Cam_Target", P(0, 1.8, 0))):
        e = bpy.data.objects.new(name, None)
        e.empty_display_size = 0.03
        e.location = loc
        collection.objects.link(e)
        cams.append(e)

    return {
        "shell": list(shell.values()),
        "gear": wall_parts + [machines] + racks + [frames],
        "desk": desk + console + controls + [lava] + cords,
        "props": props,
        "lamp": lamp,
        "bulb": bulb,
        "wall_glass": wall_glass,
        "glow": [machine_glow, rack_glow, board_glow],
        "ceiling_y": ceil_y,
        "cameras": cams,
    }


# ---------------------------------------------------------------- lights
def lights(collection, ceiling_y):
    """The lights of each pass.

    room   ceiling troffers, and the live emitters' stand-ins (signs, boards,
           cabinet and rack lamps)
    lamp   the desk lamp (terminal's lamp light, moved with the lamp)
    screen the desk terminal's picture (emission on terminal's GlassProxy)
    wall   the wall monitors' pictures (emission on Wall_GlassProxy)
    """
    scene = bpy.context.scene
    world = bpy.data.worlds.get("Closed") or bpy.data.worlds.new("Closed")
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.0, 0.0, 0.0, 1.0)
    bg.inputs["Strength"].default_value = 0.0
    scene.world = world

    troffers = []
    for i, (x, z, row) in enumerate(troffer_spots()):
        d = bpy.data.lights.new("Troffer_%02d" % i, "AREA")
        d.shape = "RECTANGLE"
        d.size, d.size_y = TROFFER_SIZE
        d.energy = TROFFER_WATTS[row]
        d.color = TROFFER_COLOR
        d.spread = math.radians(110)
        o = bpy.data.objects.new(d.name, d)
        collection.objects.link(o)
        o.location = P(x, ceiling_y - 0.045 / U, z)
        o.visible_camera = False
        o.visible_glossy = False
        troffers.append(o)

    # the desk lamp: terminal's lamp light, carried with the lamp
    pr = LAYOUT["props"]["lamp"]
    moved = T(*P(pr["x"], LAYOUT["deskY"], pr["z"])) @ turn_m(pr["turn"]) @ Matrix.Rotation(-vr.LAMP_ROT, 4, "Z") @ T(*(-vr.LAMP_POS))
    d = bpy.data.lights.new("Light_Lamp", "POINT")
    d.energy = vr.LAMP_WATTS
    d.color = vr.LAMP_COLOR
    d.shadow_soft_size = vr.LAMP_RADIUS
    lamp = bpy.data.objects.new("Light_Lamp", d)
    collection.objects.link(lamp)
    lamp.location = moved @ vr.BULB_WORLD
    lamp.visible_camera = False
    lamp.visible_glossy = False
    return {"troffers": troffers, "lamp_light": lamp, "world": world}


# ---------------------------------------------------------------- preview
def main():
    """Quick path-traced look at the room as lit, pictures on."""
    import vt_terminal
    import vt_keyboard
    import bake_lib as B
    args = vc.script_args()
    scene = vc.reset_scene()
    col = bpy.data.collections.new("Office")
    scene.collection.children.link(col)
    term = vt_terminal.build(col)
    kbd = vt_keyboard.build(col)
    out = build(col, term)
    k = LAYOUT["keyboard"]
    kbd["Keyboard"].location = P(k["x"], LAYOUT["deskY"], k["z"])
    lights(col, out["ceiling_y"])
    B.glass_setup(term["TubeRef"])
    B.glass_picture((0.10, 1.0, 0.20), 0.25)
    bsdf = out["wall_glass"].data.materials[0].node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Emission Color"].default_value = (0.10, 1.0, 0.20, 1.0)
    bsdf.inputs["Emission Strength"].default_value = 0.10
    if "--preview" in args:
        d = args[args.index("--preview") + 1]
        samples = int(args[args.index("--samples") + 1]) if "--samples" in args else 32
        seat = P(0, 2.8, 9)
        views = {
            "office_seat": (seat, P(0, 2.4, -36), 24.0),
            "office_left": (seat, P(-45, 4.0, -24), 22.0),
            "office_keys": (seat, P(0, -2.7, 3), 26.0),
            "office_gear": (seat, P(3.2, -2.5, 1.2), 62.0),
            "office_nodes": (seat, P(0, -2.2, 2.4), 85.0),
            "office_switcher": (seat, P(5.6, -1.8, -1.6), 85.0),
            "office_logbook": (seat, P(-7.6, -2.6, 3.0), 70.0),
            "office_dial": (seat, P(5.9, -2.5, 1.9), 50.0),
        }
        if "--only" in args:
            views = {k: v for k, v in views.items() if k in args[args.index("--only") + 1].split(",")}
        vc.render_previews(scene, d, views, size=(960, 540), samples=samples)
    print("OBJECTS", len([o for o in col.objects if o.type == "MESH"]),
          "TRIS", sum(vr.tri_count(o) for o in col.objects if o.type == "MESH"))


if __name__ == "__main__":
    main()
