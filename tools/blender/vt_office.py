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
from vt_room import Mesh, T, R, p_box, p_cyl, p_lathe, p_tube, p_quad, catmull, cyl_profile  # noqa: E402

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


def _node_plinth(col, mats):
    """The low sloped console the node monitors sit in, between the terminal
    and its keyboard: its top lies in the plane of the sets' bezels."""
    N = LAYOUT["nodeStrip"]
    c = LAYOUT["cabinet"]
    y = LAYOUT["deskY"]
    th = -N["lean"]
    # Up the slope and out of it, page (y, z).
    up = (math.cos(th), math.sin(th))
    out = (-math.sin(th), math.cos(th))
    rise = -c["bottom"] * N["scale"]
    cy = y + 0.1 + rise * up[0]
    cz = N["z"] + rise * up[1]
    plane = c["seam"] * N["scale"]
    oy, oz = cy + out[0] * plane, cz + out[1] * plane
    s_lo = (y - oy) / up[0]
    s_hi = (c["top"] + 0.4) * N["scale"]
    hy, hz = oy + up[0] * s_hi, oz + up[1] * s_hi
    fz = oz + up[1] * s_lo
    back_z = hz - 0.25
    half = N["halfW"]
    prof = [(fz, y), (hz, hy), (back_z, hy), (back_z, y)]
    bm = bmesh.new()
    lo = [bm.verts.new(P(-half, py, pz)) for pz, py in prof]
    hi = [bm.verts.new(P(half, py, pz)) for pz, py in prof]
    bm.faces.new(lo)
    bm.faces.new(list(reversed(hi)))
    n = len(prof)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    # the face on the desk is never seen
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.calc_center_median().z < desk_z() + 1e-5
                               and abs(f.normal.z) > 0.99], context="FACES")
    edges = [e for e in bm.edges if len(e.link_faces) == 2]
    bmesh.ops.bevel(bm, geom=edges, offset=0.002, segments=2, profile=0.5, affect="EDGES", clamp_overlap=True)
    return Mesh().add(bm, mats["body"]).finish("Node_Plinth", col)


def _controls(col, mats):
    """The static parts of the switcher on the desk: the box (its moving and
    lit parts are the page's), the keypad's base, the dial's plate and its
    ticks, and the lock button's base."""
    C = LAYOUT["controls"]
    y = LAYOUT["deskY"]
    m = Mesh()
    bx = C["box"]
    BOX = (3.3, 1.9, 2.2)
    centre = (bx["x"], y + BOX[1] / 2, bx["z"])

    def on_box(dx, dy, dz):
        tt = bx["turn"]
        return (bx["x"] + dx * math.cos(tt) + dz * math.sin(tt), y + BOX[1] / 2 + dy, bx["z"] - dx * math.sin(tt) + dz * math.cos(tt))

    box(m, mats["steel"], centre, BOX, 0.06, 2, bx["turn"])
    box(m, mats["dark"], on_box(-0.42, 0.02, BOX[2] / 2 + 0.01), (2.0, 1.45, 0.06), 0.02, 1, bx["turn"])
    box(m, mats["plate"], on_box(1.12, -0.3, BOX[2] / 2 + 0.02), (0.7, 0.74, 0.04), 0.01, 1, bx["turn"])
    box(m, mats["rubber"], (bx["x"], y + 0.04, bx["z"]), (BOX[0] + 0.1, 0.08, BOX[2] + 0.1), 0.02, 1, bx["turn"])
    switcher = m.finish("Switcher_Box", col)

    m = Mesh()
    kp = C["keypad"]
    pad_w = 4 * 0.58 + 0.3
    box(m, mats["plate"], (kp["x"], y + 0.11, kp["z"]), (pad_w, 0.22, pad_w), 0.04, 2)
    dl = C["dial"]
    box(m, mats["plate"], (dl["x"], y + 0.08, dl["z"]), (2.2, 0.16, 2.2), 0.03, 2)
    for k in range(12):
        a = k * math.pi / 6
        box(m, mats["cream"], (dl["x"] + math.sin(a) * 0.98, y + 0.18, dl["z"] - math.cos(a) * 0.98), (0.07, 0.05, 0.16),
            0.0, 1, -a, about=None)
    lk = C["lock"]

    # The page draws the button in its own units scaled by lock.scale; so
    # does this.
    ls = lk["scale"]

    def on_lock(dx, dy, dz):
        tt = lk["turn"]
        dx, dy, dz = dx * ls, dy * ls, dz * ls
        return (lk["x"] + dx * math.cos(tt) + dz * math.sin(tt), y + dy, lk["z"] - dx * math.sin(tt) + dz * math.cos(tt))

    def sized(w, h, d):
        return (w * ls, h * ls, d * ls)

    box(m, mats["steel"], on_lock(0, 0.15, 0), sized(2.3, 0.3, 2.6), 0.04 * ls, 2, lk["turn"])
    box(m, mats["hazard"], on_lock(0, 0.31, 0.42), sized(1.7, 0.04, 1.7), 0.0, 1, lk["turn"])
    box(m, mats["dark"], on_lock(0, 0.315, 0.42), sized(1.48, 0.05, 1.48), 0.0, 1, lk["turn"])
    plates = m.finish("Desk_Plates", col)
    return [switcher, plates]


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


def _props(col, mats):
    """A logbook and pen, a mug (terminal's), a headset and the desk lamp
    (terminal's, without its own cord and switch: this desk's lamp has the
    cord switch J asked for, drawn by the page)."""
    pr = LAYOUT["props"]
    y = LAYOUT["deskY"]
    out = []

    lb = pr["logbook"]
    m = Mesh()
    base = T(*P(lb["x"], y, lb["z"])) @ turn_m(lb["turn"])

    def put(piece, mat, x, py, z):
        m.add(piece, mat, base @ T(x * U, -z * U, py * U))

    put(p_box(S(3.4, 0.1, 2.3), 0.01 * U), mats["cover"], 0, 0.05, 0)
    put(p_box(S(1.58, 0.1, 2.1), 0.008 * U), mats["paper"], -0.82, 0.15, 0)
    put(p_box(S(1.58, 0.1, 2.1), 0.008 * U), mats["paper"], 0.82, 0.15, 0)
    for line in range(8):
        put(p_box(S(1.2 - (line % 3) * 0.2, 0.004, 0.03)), mats["ink"], -0.82 - (line % 3) * 0.1, 0.202, -0.8 + line * 0.22)
    pen = p_cyl(0.035 * U, -0.65 * U, 0.65 * U, 0.01 * U, 10)
    m.add(pen, mats["black"], base @ T(0.7 * U, -0.1 * U, 0.24 * U) @ R(90, "X") @ R(25, "Y"))
    out.append(m.finish("Logbook", col))

    mug = vr._mug(col)
    mg = pr["mug"]
    mug.location = P(mg["x"], y, mg["z"])
    out.append(mug)

    hs = pr["headset"]
    m = Mesh()
    base = T(*P(hs["x"], y, hs["z"])) @ turn_m(hs["turn"])
    for sx in (-1, 1):
        cup = p_cyl(0.42 * U, 0.0, 0.26 * U, 0.05 * U, 24)
        m.add(cup, mats["black"], base @ T(sx * 0.55 * U, 0, 0.0))
        m.add(p_cyl(0.36 * U, 0.26 * U, 0.34 * U, 0.04 * U, 24), mats["pad"], base @ T(sx * 0.55 * U, 0, 0.0))
    band = [Vector((math.cos(a) * 0.62 * U, -0.1 * U, (0.13 + math.sin(a) * 0.62) * U))
            for a in [math.pi * k / 12 for k in range(13)]]
    band = [Vector((p.x, p.y, max(p.z * 0.25, 0.03 * U))) for p in band]
    m.add(p_tube(band, 0.05 * U, 8), mats["black"], base)
    m.add(p_tube([Vector((-0.75 * U, -0.45 * U, 0.3 * U)), Vector((-0.75 * U, -1.3 * U, 0.08 * U))], 0.025 * U, 8),
          mats["hsteel"], base)
    m.add(p_box(S(0.12, 0.12, 0.18), 0.02 * U), mats["black"], base @ T(-0.75 * U, -1.33 * U, 0.08 * U))
    out.append(m.finish("Headset", col))

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
    plinth = _node_plinth(collection, mats)
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
        "desk": desk + [plinth] + controls + [lava] + cords,
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
        }
        vc.render_previews(scene, d, views, size=(960, 540), samples=samples)
    print("OBJECTS", len([o for o in col.objects if o.type == "MESH"]),
          "TRIS", sum(vr.tri_count(o) for o in col.objects if o.type == "MESH"))


if __name__ == "__main__":
    main()
