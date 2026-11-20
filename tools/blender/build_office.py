"""Model the security office, bake its light and write the page's assets.

    blender -b --factory-startup --python tools/blender/build_office.py -- [flags]

One run writes into client/assets/ (<N> is the atlas size and its halvings):
    office.glb                     geometry only, meshopt compressed, two UV sets
    lm_<atlas>_<pass>_<N>.webp     light maps: atlas hero (terminal, keyboard),
                                   desk (desk and what is on it), room (the
                                   rest); pass room (ceiling lights and the
                                   live gear's glow), lamp (desk lamp), screen
                                   (desk terminal's picture), wall (the wall
                                   monitors' pictures)

Flags (all optional):
    --size N            atlas size (default 4096)
    --samples N         bake samples per texel of the hero atlas (default
                        1024 at 2048, a quarter of that at 4096)
    --skip-bake         reuse the EXR masters in --bake-dir
    --reuse-unchanged   bake only the atlases whose layout or samples changed
    --preview DIR       also render check images into DIR
    --preview-samples N samples of the beauty renders (default 128)
    --no-beauty         with --preview: skip the path-traced beauty renders
    --out DIR           asset directory (default <repo>/client/assets)
    --bake-dir DIR      where the EXR masters go (default <temp>/office_bake)
    --no-smooth         do not filter bake grain
    --no-export         stop before writing office.glb
    --blend             save the assembled scene in the bake dir

Quick look on any machine (a CPU does it in some minutes):
    --size 512 --samples 4 --no-beauty --preview <dir> --out <scratch dir>

See README.md for the contract with the page.
"""
import json
import math
import os
import sys
import tempfile
import time

import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vt_common as vc  # noqa: E402
import vt_terminal  # noqa: E402
import vt_keyboard  # noqa: E402
import vt_office as vo  # noqa: E402
import bake_lib as B  # noqa: E402

REPO = os.path.dirname(os.path.dirname(HERE))
log = B.log
arg = B.arg

# ---------------------------------------------------------------- scene description for bake_lib
PASSES = ("room", "lamp", "screen", "wall")
ATLASES = ("hero", "desk", "room")
B.PASSES = PASSES
B.RANGE_SKIP = ("Lamp_Shade",)
B.WARPS = {}
# Samples per texel at 2048 (fewer at larger sizes: see terminal's README).
SAMPLES_2048 = {"hero": 1024, "desk": 2048, "room": 768}
PASS_SAMPLES = {"room": 0.5, "lamp": 1.0, "screen": 0.5, "wall": 0.5}
B.DENSITY = (
    ("NameplateText", 2.0), ("Nameplate", 2.0), ("Collar", 1.2), ("PowerButton", 1.2),
    ("Housing", 0.8), ("Plinth", 0.8), ("SideControls", 0.8), ("RearDetails", 0.3),
    ("Key_", 1.25), ("LegendStrip", 1.3), ("Kbd_Feet", 0.3), ("Kbd_", 1.0), ("Keyboard", 1.0),
    ("Desk_Top", 0.7), ("Desk_Body", 0.4), ("Switcher_", 1.6), ("Keypad_Case", 1.6), ("Pad_", 1.8), ("Dial_", 1.6),
    ("Node_Console", 1.2), ("Node_Plate", 1.6), ("Node_Set_", 1.8),
    ("Lava_Metal", 1.6), ("Cord_", 0.8), ("Lamp_", 1.3), ("Mug", 2.0), ("Logbook", 1.4),
    ("Wall_Sets", 1.6), ("Wall_Rack", 0.9), ("Machine_", 1.4), ("Rack_", 1.4), ("Board_", 1.2),
    ("Room_Floor", 0.5), ("Room_Ceiling", 0.25), ("Room_Wall", 0.5), ("Room_Back", 0.5), ("Room_", 0.5),
)
B.SMOOTH = (
    ("Key_", 1.0), ("Collar", 1.0), ("Keyboard", 1.0), ("Housing", 1.0), ("Plinth", 1.0),
    ("SideControls", 1.0), ("PowerButton", 1.0),
    ("Room_", 3.0), ("Wall_Rack", 2.0), ("Machine_", 1.5), ("Rack_", 1.5), ("Board_", 1.5), ("Wall_Sets", 1.0),
    ("Desk_Body", 1.5), ("Lamp_", 1.0), ("Node_", 1.0), ("Pad_", 2.0), ("Switcher_", 1.0), ("Keypad_Case", 2.0),
    ("Dial_", 2.0),
)
B.SMOOTH_REST = 0.5

# The eye: the seat, and the way to the terminal when the view locks on it
# (client/scene.js EYE and DESK_EYE), with some room round both.
SEAT = vo.P(0, 2.8, 9)
DESK_EYE = vo.P(0, 0.3, 6.6)
B.SEAT = SEAT


def viewpoints():
    pts = []
    for x in (-1.5, 0.0, 1.5):
        for y in (2.0, 2.8, 3.8):
            for z in (8.0, 9.0, 10.5):
                pts.append(vo.P(x, y, z))
    for k in range(6):
        pts.append(SEAT.lerp(DESK_EYE, k / 5))
    return pts


def views():
    """name: (camera, target, lens mm, (w, h)), sensor 36 mm on the long side."""
    return {
        "seat": (SEAT, vo.P(0, 2.4, -36), 24.0, (1280, 720)),
        "keys": (SEAT, vo.P(0, -2.7, 3), 26.0, (1280, 720)),
        "left": (SEAT, vo.P(-45, 4.0, -24), 22.0, (1280, 720)),
        "right": (SEAT, vo.P(45, 4.0, -24), 22.0, (1280, 720)),
        "up": (SEAT, vo.P(0, 18, -36), 24.0, (1280, 720)),
        "desk_lock": (DESK_EYE, vo.P(0, 0, 0), 30.0, (1280, 720)),
    }


# Kept whole (never trimmed): small moving or recoloured parts.
KEEP_ALL = ("PowerButton", "PowerLED", "Nameplate", "Kbd_LED_", "Node_Set_", "Pad_", "Dial_Knob", "Switcher_Guard",
            "Switcher_Lever")
# The page lifts the power switch's guard, so it hides nothing from the trim
# and casts no shadow on its own atlas; it is baked apart, after the rest.
GUARD = "Switcher_Guard"


def look_material(name, maps):
    """Emission = sum of decoded maps times their scale (rgb); back faces glow
    magenta so holes show."""
    mat = bpy.data.materials.new(name)
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    uv = nt.nodes.new("ShaderNodeUVMap")
    uv.uv_map = B.LM_NAME
    acc = None
    for path, scale in maps:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = bpy.data.images.load(path, check_existing=True)
        t.image.colorspace_settings.name = "sRGB"
        t.interpolation = "Linear"
        t.extension = "EXTEND"
        nt.links.new(uv.outputs["UV"], t.inputs["Vector"])
        mul = nt.nodes.new("ShaderNodeVectorMath")
        mul.operation = "MULTIPLY"
        mul.inputs[1].default_value = tuple(scale)
        nt.links.new(t.outputs["Color"], mul.inputs[0])
        if acc is None:
            acc = mul
        else:
            add = nt.nodes.new("ShaderNodeVectorMath")
            add.operation = "ADD"
            nt.links.new(acc.outputs["Vector"], add.inputs[0])
            nt.links.new(mul.outputs["Vector"], add.inputs[1])
            acc = add
    em = nt.nodes.new("ShaderNodeEmission")
    nt.links.new(acc.outputs["Vector"], em.inputs["Color"])
    back = nt.nodes.new("ShaderNodeEmission")
    back.inputs["Color"].default_value = (1.0, 0.0, 1.0, 1.0)
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(geo.outputs["Backfacing"], mix.inputs["Fac"])
    nt.links.new(em.outputs[0], mix.inputs[1])
    nt.links.new(back.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    return mat


# What the check renders light the pictures with (linear radiance): green
# phosphor at a quarter level on the desk terminal, and the wall at a tenth.
PICTURE_RGB = (0.10, 1.0, 0.20)
DESK_LEVEL = 0.25
WALL_LEVEL = 0.10


def set_emission(mat, strength, color=(1, 1, 1)):
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Emission Color"].default_value = (*color, 1.0)
    bsdf.inputs["Emission Strength"].default_value = strength


def main():
    args = vc.script_args()
    size = arg(args, "--size", 4096, int)
    per_texel = (2048.0 / size) ** 2
    hero_samples = arg(args, "--samples", max(1, round(SAMPLES_2048["hero"] * per_texel)), int)
    atlas_samples = {a: max(1, round(hero_samples * SAMPLES_2048[a] / SAMPLES_2048["hero"])) for a in ATLASES}
    tiers = [size >> i for i in range(B.TIERS) if (size >> i) >= B.TIER_MIN and size % (1 << i) == 0] or [size]
    dilate_px = max(1, int(round(B.DILATE_PX * size / 2048.0)))
    out_dir = arg(args, "--out", os.path.join(REPO, "client", "assets"))
    bake_dir = arg(args, "--bake-dir", os.path.join(tempfile.gettempdir(), "office_bake"))
    preview = arg(args, "--preview")
    pv_samples = arg(args, "--preview-samples", 128, int)
    skip_bake = "--skip-bake" in args
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(bake_dir, exist_ok=True)
    t_start = time.time()
    report = {"size": size, "samples": atlas_samples}

    # ---------------------------------------------------------- build
    scene = vc.reset_scene()
    col = bpy.data.collections.new("Office")
    scene.collection.children.link(col)
    T = vt_terminal.build(col)
    K = vt_keyboard.build(col)
    O = vo.build(col, T)
    L = vo.lights(col, O["ceiling_y"])

    kb = K["Keyboard"]
    k = vo.LAYOUT["keyboard"]
    kb.location = vo.P(k["x"], vo.LAYOUT["deskY"], k["z"])
    kb.rotation_euler = (0.0, 0.0, k["turn"])
    bpy.context.view_layer.update()

    tube, glass = T["TubeRef"], T["GlassProxy"]
    B.glass_setup(tube)
    led_bsdf = bpy.data.materials["PowerLED"].node_tree.nodes["Principled BSDF"]
    led_strength = led_bsdf.inputs["Emission Strength"].default_value
    bulb = O["bulb"]
    wall_glass = O["wall_glass"]
    wall_mat = wall_glass.data.materials[0]
    glows = O["glow"]

    hero_all = T["body"] + [T["PowerButton"], kb] + K["keys"] + [K["LegendStrip"]] + K["parts"]
    desk_all = O["desk"] + O["props"] + O["lamp"]
    room_all = O["shell"] + O["gear"]
    led_objs = [T["PowerLED"]] + K["leds"]
    groups = {"hero": hero_all, "desk": desk_all, "room": room_all}

    # ---------------------------------------------------------- intersections
    def named(*prefixes):
        return [o for o in desk_all if o.name.startswith(prefixes)]

    bad = B.check_intersections(
        {"keyboard": [kb] + K["keys"] + [K["LegendStrip"]] + K["leds"] + K["parts"],
         "terminal": T["body"] + [T["PowerButton"], T["PowerLED"], glass],
         "console": named("Node_"), "selector": named("Keypad_Case", "Pad_", "Dial_"),
         "switcher": named("Switcher_"), "props": O["props"], "lamp": O["lamp"] + [bulb]},
        set())
    report["intersections"] = bad
    log("INTERSECTIONS", bad if bad else "none")
    if bad:
        raise RuntimeError("objects intersect: %r" % (bad,))

    # ---------------------------------------------------------- beauty (ground truth)
    def picture(desk_level, wall_level):
        B.glass_picture(PICTURE_RGB, desk_level)
        set_emission(wall_mat, wall_level, PICTURE_RGB)

    if preview and "--no-beauty" not in args:
        picture(DESK_LEVEL, WALL_LEVEL)
        t0 = time.time()
        B.render_views(scene, views(), preview, "beauty", pv_samples, True)
        log("beauty renders %.0f s" % (time.time() - t0))
    picture(0.0, 0.0)

    # ---------------------------------------------------------- what can be seen
    t0 = time.time()
    all_mesh = [o for o in col.objects if o.type == "MESH" and not o.get("role") == "proxy"
                and o not in glows and o is not bulb]
    button = T["PowerButton"]
    keyset = set(K["keys"])
    occluders = [o for o in all_mesh if o is not button and o.name != GUARD] + [wall_glass, glass]
    world_all = B.World(occluders)
    world_nokeys = B.World([o for o in occluders if o not in keyset])
    eyes = viewpoints()
    state, weights = {}, {}
    keep_objs = []
    vis_rows = []
    for o in hero_all + desk_all + room_all + led_objs + [bulb]:
        _, grow, _ = B.face_visibility(o, world_nokeys if o in keyset else world_all, eyes)
        st = grow.astype(np.int8)
        if o.name.startswith(KEEP_ALL):
            st[:] = 1
        state[o.name] = st
        weights[o.name] = B.face_weights(o)
        vis_rows.append((o.name, int((st > 0).sum()), len(st)))
        if (st > 0).any():
            keep_objs.append(o)
    log("visibility %.0f s" % (time.time() - t0))
    report["dropped_objects"] = [n for n, kk, _ in vis_rows if kk == 0]
    log("DROPPED (never seen):", report["dropped_objects"])
    for n, kk, tt in vis_rows:
        if not n.startswith("Key_"):
            log("VIS %-20s %6d of %6d faces kept" % (n, kk, tt))
    atlases = {a: [o for o in groups[a] if o in keep_objs] for a in ATLASES}

    # ---------------------------------------------------------- lightmap UVs
    for name, objs in atlases.items():
        t0 = time.time()
        info = B.layout_atlas(objs, state, weights, size, {})
        log("UV %s: %s  (%.0f s)" % (name, info, time.time() - t0))
        report["uv_" + name] = info
    for o in led_objs + ([bulb] if bulb in keep_objs else []):
        me = o.data
        while len(me.uv_layers) > 1:
            me.uv_layers.remove(me.uv_layers[-1])
        me.uv_layers.new(name=B.LM_NAME, do_init=False)
        B.set_uv(me, np.zeros((len(me.loops), 2)))
    checksum = {n: B.uv_checksum(objs) for n, objs in atlases.items()}
    masks, labels = {}, {}
    for name, objs in atlases.items():
        labels[name] = B.raster_labels(objs, state, size)
        masks[name] = labels[name] >= 0
        log("mask %s: %.1f%% of the atlas covered" % (name, 100 * masks[name].mean()))
    range_skip = {}
    for name, objs in atlases.items():
        skip = [o for o in objs if o.name in B.RANGE_SKIP]
        range_skip[name] = B.grow_mask(B.label_mask(labels[name], objs, skip), 2)

    if "--blend" in args:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(bake_dir, "office.blend"))

    # ---------------------------------------------------------- bake
    meta_path = os.path.join(bake_dir, "bake_meta.json")
    pass_samples = {n: {p: max(1, round(atlas_samples[n] * PASS_SAMPLES[p])) for p in PASSES} for n in atlases}
    want = {n: {"checksum": checksum[n], "size": size, "samples": pass_samples[n]} for n in atlases}
    have = {}
    if os.path.exists(meta_path):
        with open(meta_path) as f:
            have = json.load(f).get("atlases", {})
    layers = PASSES + ("color",)

    def master(name, layer):
        return os.path.join(bake_dir, "raw_%s_%s.exr" % (name, layer))

    def same_layout(name):
        return (name in have and have[name].get("checksum") == checksum[name] and have[name].get("size") == size
                and all(os.path.exists(master(name, layer)) for layer in layers))

    if skip_bake:
        stale = [n for n in atlases if not same_layout(n)]
        if stale:
            raise RuntimeError("--skip-bake: no masters for this layout in %s (%s)" % (bake_dir, ", ".join(stale)))
        reuse = set(atlases)
    elif "--reuse-unchanged" in args:
        reuse = set(n for n in atlases if same_layout(n) and have[n] == want[n])
    else:
        reuse = set()
    raw, covered = {}, {}

    def take(name, layer, arr):
        alpha = arr[..., 3] > 0
        covered[name] = alpha if name not in covered else covered[name] & alpha
        raw[(name, layer)] = np.nan_to_num(arr[..., :3], nan=0.0, posinf=0.0, neginf=0.0)
        return alpha

    for name in sorted(reuse):
        for layer in layers:
            take(name, layer, B.load_image(master(name, layer)))
        want[name] = have[name]
        log("reused baked masters of %s" % name)
    todo = [n for n in atlases if n not in reuse]
    if todo:
        B.setup_bake_device(scene, hero_samples)
        led_bsdf.inputs["Emission Strength"].default_value = 0.0
        sources = {
            "room": L["troffers"] + glows,
            "lamp": [L["lamp_light"], bulb],
            "screen": [],
            "wall": [],
        }
        switchable = L["troffers"] + glows + [L["lamp_light"], bulb]
        stand_ins, guards, spare_mats = {}, {}, []
        for name in todo:
            lone = [o for o in atlases[name] if o.name == GUARD]
            stand_ins[name], mats = B.joined_copy([o for o in atlases[name] if o not in lone], col, "Bake_" + name)
            spare_mats += mats
            if lone:
                guards[name], mats = B.joined_copy(lone, col, "Bake_guard")
                spare_mats += mats
            for o in atlases[name]:
                o.hide_render = True
        for layer in layers:
            if layer != "color":
                scene.world = L["world"]
                B.glass_picture((1, 1, 1), 1.0 if layer == "screen" else 0.0)
                set_emission(wall_mat, 1.0 if layer == "wall" else 0.0)
                for o in switchable:
                    o.hide_render = o not in sources[layer]
            for name in todo:
                t0 = time.time()
                img = bpy.data.images.new("bake_%s_%s" % (name, layer), size, size, alpha=True, float_buffer=True)
                spp = B.COLOR_SAMPLES if layer == "color" else pass_samples[name][layer]
                scene.cycles.samples = spp
                kind = ("COLOR",) if layer == "color" else ("DIRECT", "INDIRECT")
                for g in guards.values():
                    g.hide_render = name in guards
                B.bake_into(scene, [stand_ins[name]], img, kind)
                arr = B.image_array(img)
                if name in guards:
                    guards[name].hide_render = False
                    B.bake_into(scene, [guards[name]], img, kind)
                    own = B.image_array(img)
                    arr[own[..., 3] > 0] = own[own[..., 3] > 0]
                take(name, layer, arr)
                B.save_exr(arr, master(name, layer))
                bpy.data.images.remove(img)
                log("BAKE %s/%s: %d objects, %d spp, %d px, %.0f s" % (name, layer, len(atlases[name]), spp, size, time.time() - t0))
        for proxy in list(stand_ins.values()) + list(guards.values()):
            me = proxy.data
            bpy.data.objects.remove(proxy)
            bpy.data.meshes.remove(me)
        for name in todo:
            for o in atlases[name]:
                o.hide_render = False
        for m in spare_mats:
            bpy.data.materials.remove(m)
        B.glass_picture((1, 1, 1), 0.0)
        set_emission(wall_mat, 0.0)
        for o in switchable:
            o.hide_render = False
        led_bsdf.inputs["Emission Strength"].default_value = led_strength
        with open(meta_path, "w") as f:
            json.dump({"atlases": want}, f)

    # ---------------------------------------------------------- encode
    enc, files, grown_maps = {}, {}, {}
    for fn in os.listdir(out_dir):
        if fn.startswith("lm_") and fn.endswith(".webp"):
            os.remove(os.path.join(out_dir, fn))
    for name in atlases:
        masks[name] = masks[name] & covered[name]
    for name in atlases:
        color = raw.pop((name, "color"))
        for pas in PASSES:
            t0 = time.time()
            light = raw.pop((name, pas))
            if "--no-smooth" not in args:
                light, _ = B.smooth_light(light, masks[name], labels[name], atlases[name], size)
            rgb = light * color
            grown, _ = B.dilate(rgb, masks[name], dilate_px)
            grown_maps[(name, pas)] = grown
            path = os.path.join(out_dir, "lm_%s_%s_%d.webp" % (name, pas, size))
            enc[(name, pas)] = B.encode_map(grown, masks[name], path, "%s/%s" % (name, pas), masks[name] & ~range_skip[name])
            files[(name, pas, size)] = path
            for i, tier in enumerate(tiers[1:], 1):
                files[(name, pas, tier)] = os.path.join(out_dir, "lm_%s_%s_%d.webp" % (name, pas, tier))
                B.save_bytes(B.to_bytes(B.halve(grown, i), enc[(name, pas)]["range"]), files[(name, pas, tier)])
            log("encoded %s/%s (%.0f s)" % (name, pas, time.time() - t0))
    report["encode"] = {"%s_%s" % kk: v for kk, v in enc.items()}

    # ---------------------------------------------------------- strip unseen faces
    tri_before = tri_after = 0
    for o in keep_objs:
        me = o.data
        me.calc_loop_triangles()
        tri_before += len(me.loop_triangles)
        st = state[o.name]
        if (st == 0).any():
            bm = bmesh.new()
            bm.from_mesh(me)
            bm.faces.ensure_lookup_table()
            bmesh.ops.delete(bm, geom=[f for f in bm.faces if st[f.index] == 0], context="FACES")
            bm.to_mesh(me)
            bm.free()
        me.calc_loop_triangles()
        tri_after += len(me.loop_triangles)
    log("TRIM %d -> %d triangles" % (tri_before, tri_after))

    # ---------------------------------------------------------- properties
    for name, objs in atlases.items():
        for o in objs:
            o["atlas"] = name
    for o in led_objs:
        o["role"] = "led"
    if bulb in keep_objs:
        bulb["role"] = "emissive"
        bulb["emissive"] = [1.0, 0.86, 0.66]
    ranges = {}
    for name in atlases:
        for pas in PASSES:
            ranges["%s_range_%s" % (pas, name)] = enc[(name, pas)]["range"]
    for kk, v in ranges.items():
        scene[kk] = v
    scene["tube_unit"] = vc.TUBE_UNIT
    scene["lightmap_size"] = size
    scene["lightmap_sizes"] = sorted(tiers)
    scene["picture_scale"] = [0.88, 0.84]
    scene["wall_picture_scale"] = [1.0, 1.0]
    scene["atlases"] = list(ATLASES)
    scene["passes"] = list(PASSES)
    scene["desk_y"] = vo.LAYOUT["deskY"]
    report["ranges"] = ranges

    glow_objs = []
    for o in [x for x in atlases["desk"] if x.name in B.RANGE_SKIP]:
        whole = grown_maps[("desk", "room")] + grown_maps[("desk", "lamp")]
        g, rad, rad_off = B.split_glow(o, col, whole, enc[("desk", "lamp")]["range"], size,
                                       also=grown_maps[("desk", "room")])
        if g is None:
            continue
        del g["atlas"]
        g["role"] = "emissive"
        g["emissive"] = [round(min(float(c), 1.0), 4) for c in rad]
        g["emissive_radiance"] = [round(float(c), 4) for c in rad]
        g["emissive_off"] = [round(float(c), 5) for c in rad_off]
        glow_objs.append(g)
        keep_objs.append(g)
        log("GLOW %s: %d faces" % (g.name, len(g.data.polygons)))
    backing = B.build_backing(col)
    keep_objs.append(backing)

    # ---------------------------------------------------------- baked look
    if preview:
        t0 = time.time()
        desk_e = [c * DESK_LEVEL for c in PICTURE_RGB]
        wall_e = [c * WALL_LEVEL for c in PICTURE_RGB]
        for name, objs in atlases.items():
            scale = {"room": [1, 1, 1], "lamp": [1, 1, 1], "screen": desk_e, "wall": wall_e}
            maps = [(files[(name, p, size)], [c * enc[(name, p)]["range"] for c in scale[p]]) for p in PASSES]
            mat = look_material("Look_" + name, maps)
            for o in objs:
                B.set_single_material(o, mat)
        for o in led_objs:
            B.set_single_material(o, B.flat_material("Look_LED_" + o.name, (0.02, 0.05, 0.02)))
        if bulb in keep_objs:
            B.set_single_material(bulb, B.flat_material("Look_Bulb", (1.0, 0.86, 0.66)))
        for g in glow_objs:
            B.set_single_material(g, B.flat_material("Look_" + g.name, tuple(g["emissive"])))
        B.set_single_material(backing, B.flat_material("Look_Backing", (0.0, 0.0, 1.0)))
        hidden = []
        for o in list(col.objects):
            if o not in keep_objs and o.type in ("MESH", "LIGHT") and not o.hide_render and o is not wall_glass:
                o.hide_render = True
                hidden.append(o)
        set_emission(wall_mat, WALL_LEVEL, PICTURE_RGB)
        scene.world = B.black_world()
        B.render_views(scene, views(), preview, "baked", 16, False)
        for o in hidden:
            o.hide_render = False
        log("baked-look renders %.0f s" % (time.time() - t0))
        for (name, pas, tier), path in files.items():
            if tier == size:
                b = np.round(B.load_image(path, raw=True)[..., :3] * 255).astype(np.uint8)
                B.save_bytes(b, os.path.join(preview, "atlas_%s_%s.png" % (name, pas)), fmt="PNG")

    # ---------------------------------------------------------- export
    stats = None
    if "--no-export" not in args:
        plain = bpy.data.materials.new("Baked")
        plain.use_backface_culling = True
        legend_users = set(K["keys"]) | {K["LegendStrip"]} | set(o for o in keep_objs if "decals" in o)
        for o in keep_objs:
            B.set_single_material(o, plain)
            o.data.name = o.name
            uv0 = B.get_uv(o.data, "UVMap")
            uv0 = np.round(uv0 * 8192.0) / 8192.0 if o in legend_users else np.zeros_like(uv0)
            B.set_uv(o.data, uv0, "UVMap")
            assert [lay.name for lay in o.data.uv_layers] == ["UVMap", B.LM_NAME], (o.name, [lay.name for lay in o.data.uv_layers])
        export_objs = keep_objs + [tube] + O["cameras"]
        bpy.ops.object.select_all(action="DESELECT")
        for o in export_objs:
            o.hide_render = False
            o.hide_set(False)
            o.select_set(True)
        bpy.context.view_layer.objects.active = kb
        glb = os.path.join(out_dir, "office.glb")
        B.tune_meshopt_precision()
        bpy.ops.export_scene.gltf(
            filepath=glb, export_format="GLB", use_selection=True, export_apply=True,
            export_texcoords=True, export_normals=True, export_extras=True, export_yup=True,
            export_cameras=False, export_lights=False, export_animations=False,
            export_materials="EXPORT", export_image_format="NONE",
            export_meshopt_compression_enable=True, export_meshopt_extension="EXT_meshopt_compression")
        try:
            stats = B.verify_glb(glb, {o.name: o for o in keep_objs}, size)
        except OSError as e:
            # pip's bpy has no meshopt library to decode with; Blender has.
            log("GLB written, not verified (%s)" % e)
            stats = None
    if "--no-export" not in args and stats is not None:
        names = [n["name"] for n in stats["nodes"]]
        for must in ("TubeRef", "Cam_Seat", "Keyboard", "Wall_Sets", "Desk_Top"):
            assert must in names, must + " missing from the glb"
        assert all(n["extras"].get("role") != "proxy" for n in stats["nodes"])
        assert stats["images"] == 0 and stats["textures"] == 0
        for kk in ranges:
            assert kk in stats["scene_extras"], kk + " missing from scene extras"
        report["glb"] = {kk: stats[kk] for kk in ("file_bytes", "triangles", "vertices", "max_pos_err_mm", "max_uv1_err_texel")}
        log("GLB %d bytes, %d nodes, %d triangles, max position error %.4f mm, max uv1 error %.4f texel" % (
            stats["file_bytes"], len(stats["nodes"]), stats["triangles"], stats["max_pos_err_mm"], stats["max_uv1_err_texel"]))
        for n in stats["nodes"]:
            if not (n["name"] or "").startswith("Key_"):
                log("NODE %-20s tris %6s role %-8s atlas %-5s" % (
                    n["name"], n.get("triangles", "-"), n["extras"].get("role", "-"), n["extras"].get("atlas", "-")))

    for fn in sorted(os.listdir(out_dir)):
        log("ASSET %-28s %9d bytes" % (fn, os.path.getsize(os.path.join(out_dir, fn))))
    with open(os.path.join(bake_dir, "report.json"), "w") as f:
        json.dump(report, f, indent=1, default=lambda o: o if isinstance(o, (int, float, str)) else str(o))
    log("done in %.0f s" % (time.time() - t_start))


if __name__ == "__main__":
    main()
