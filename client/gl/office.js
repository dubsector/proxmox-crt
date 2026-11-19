// The modelled office: room, gear, desk, the terminal and its keyboard,
// built and baked in Blender by tools/blender/build_office.py. Adapted from
// dubsector/terminal's model.js. Everything here is read from the files at
// load - node names and their properties, the ranges the light maps were
// stored with - so a re-bake needs no change on this side.
//
// What moves or lights up is not in the model: scene.js keeps drawing it
// live, in front of the baked surfaces, and hides its own plain stand-ins
// for what the model now draws.
import { ClampToEdgeWrapping, Color, LinearFilter, MeshBasicMaterial, Quaternion, SRGBColorSpace, Texture, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

// What build.mjs put in dist/assets: `files` maps each asset's name to the
// content-hashed name it is served under, `sizes` lists the atlas sizes the
// light maps come in, smallest first. No sizes: there is no bake yet.
/* global __ASSETS__ */
var ASSETS = typeof __ASSETS__ === "undefined" ? { files: {}, sizes: [] } : __ASSETS__;

export var ATLASES = ["hero", "desk", "room"];
// The light passes baked into each atlas; they add up (see bakedMaterial).
export var PASSES = ["room", "lamp", "screen", "wall"];
// Twelve maps take 64 MB each on the GPU at 4096. A phone or a small
// machine stops at this size.
var SMALL_DEVICE_MAP_SIZE = 2048;

var LED_ON = 0xb4d23a;
var LED_OFF = 0x262b10;
var EMISSIVE_TOWARD_WHITE = 0.35;

// How far a key goes down, and how fast (see terminal's keys.js).
var KEY_DOWN_S = 0.03;
var KEY_UP_S = 0.07;
var KEY_STRIKE_S = 0.09;
// The PC keys this keyboard has no key for go down on the one where it
// sits: Escape on F11 (ESC), Alt on Compose Character, F1 to F5 on the
// terminal's own keys above, and the numpad's top row on PF1 to PF4.
var KEY_STAND_INS = {
  Escape: "F11",
  AltLeft: "VT_Compose",
  AltRight: "VT_Compose",
  ControlRight: "ControlLeft",
  F1: "VT_HoldScreen",
  F2: "VT_PrintScreen",
  F3: "VT_SetUp",
  F4: "VT_DataTalk",
  F5: "VT_Break",
  NumLock: "VT_PF1",
  NumpadDivide: "VT_PF2",
  NumpadMultiply: "VT_PF3",
  NumpadAdd: "NumpadComma",
};

export function officeAvailable() {
  return ASSETS.sizes.length > 0 && !!ASSETS.files["office.glb"];
}

// The atlas size to end up with: the largest the GPU takes and the device
// can afford. ?lm=1024 (or any size) caps it.
export function pickMapSize(maxTextureSize) {
  var cap = maxTextureSize;
  var asked = /[?&]lm=(\d+)(&|$)/.exec(window.location.search);
  var coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  if (asked) cap = Math.min(cap, +asked[1]);
  else if (coarse || navigator.deviceMemory <= 4) cap = Math.min(cap, SMALL_DEVICE_MAP_SIZE);
  var best = ASSETS.sizes[0];
  ASSETS.sizes.forEach(function (size) {
    if (size <= cap) best = size;
  });
  return best;
}

// Starts the downloads: the model and the smallest light maps at once
// (`promise`), then the maps at `mapSize` (`better`, null if the first set
// is already that size).
export function loadOffice(base, mapSize) {
  var textures = [];
  var cancelled = false;
  var abort = new AbortController();

  function failed(file) {
    return function (err) {
      var why = err && err.message ? err.message : "";
      throw new Error("could not load " + file + (why ? ": " + why : ""));
    };
  }

  function fetchFile(file, as) {
    if (!ASSETS.files[file]) return Promise.reject(new Error("not in this build"));
    return fetch(base + ASSETS.files[file], { signal: abort.signal }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r[as]();
    });
  }

  function lightMap(file) {
    return fetchFile(file, "blob")
      .then(function (blob) {
        return createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
      })
      .then(function (bitmap) {
        var t = new Texture(bitmap);
        t.colorSpace = SRGBColorSpace;
        t.flipY = false;
        // Islands are only a few texels apart: no mip maps.
        t.generateMipmaps = false;
        t.minFilter = LinearFilter;
        t.magFilter = LinearFilter;
        t.wrapS = t.wrapT = ClampToEdgeWrapping;
        // The second UV set addresses the atlas.
        t.channel = 1;
        t.needsUpdate = true;
        if (cancelled) t.dispose();
        else textures.push(t);
        return t;
      })
      .catch(failed(file));
  }

  function mapSet(size) {
    var jobs = [];
    ATLASES.forEach(function (name) {
      PASSES.forEach(function (pass) {
        jobs.push(lightMap("lm_" + name + "_" + pass + "_" + size + ".webp"));
      });
    });
    return Promise.all(jobs).then(function (r) {
      var maps = {};
      var k = 0;
      ATLASES.forEach(function (name) {
        maps[name] = {};
        PASSES.forEach(function (pass) {
          maps[name][pass] = r[k++];
        });
      });
      return maps;
    });
  }

  var firstSize = ASSETS.sizes[0];
  var first = Promise.all([
    fetchFile("office.glb", "arrayBuffer")
      .then(function (buf) {
        return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buf, base);
      })
      .catch(failed("office.glb")),
    mapSet(firstSize),
  ]).then(function (r) {
    return { gltf: r[0], maps: r[1] };
  });

  return {
    promise: first,
    better: first.then(function () {
      return mapSize > firstSize && !cancelled ? mapSet(mapSize) : null;
    }),
    release: function (maps) {
      ATLASES.forEach(function (name) {
        PASSES.forEach(function (pass) {
          var t = maps[name][pass];
          textures.splice(textures.indexOf(t), 1);
          t.dispose();
          if (t.image && t.image.close) t.image.close();
        });
      });
    },
    dispose: function () {
      cancelled = true;
      abort.abort();
      textures.forEach(function (t) {
        t.dispose();
        if (t.image && t.image.close) t.image.close();
      });
      textures.length = 0;
    },
  };
}

// MeshBasicMaterial's light map is the room pass (the ceiling lights), scaled
// by roomLevel. Three more maps on the same texels add the desk lamp's light
// (lampLevel), the desk terminal's picture (screenLight: its colour times
// its mean level) and the wall's pictures (wallLight: the same over the wall).
// three multiplies the light map by lightMapIntensity / PI and the room map
// stores radiance / range, so the intensity is PI * range; the other maps
// have their own ranges, hence the ratios.
function bakedMaterial(maps, ranges, light, legend) {
  var mat = new MeshBasicMaterial({
    lightMap: maps.room,
    lightMapIntensity: Math.PI * ranges.room,
    map: legend || null,
  });
  var u = {
    lampLightMap: { value: maps.lamp },
    screenLightMap: { value: maps.screen },
    wallLightMap: { value: maps.wall },
    lampScale: { value: ranges.lamp / ranges.room },
    screenScale: { value: ranges.screen / ranges.room },
    wallScale: { value: ranges.wall / ranges.room },
  };
  mat.userData.setMaps = function (next) {
    mat.lightMap = next.room;
    u.lampLightMap.value = next.lamp;
    u.screenLightMap.value = next.screen;
    u.wallLightMap.value = next.wall;
  };
  mat.onBeforeCompile = function (shader) {
    Object.keys(u).forEach(function (k) {
      shader.uniforms[k] = u[k];
    });
    shader.uniforms.roomLevel = light.room;
    shader.uniforms.lampLevel = light.lamp;
    shader.uniforms.screenLight = light.screen;
    shader.uniforms.wallLight = light.wall;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <lightmap_pars_fragment>",
        [
          "#include <lightmap_pars_fragment>",
          "uniform sampler2D lampLightMap;",
          "uniform sampler2D screenLightMap;",
          "uniform sampler2D wallLightMap;",
          "uniform float lampScale;",
          "uniform float screenScale;",
          "uniform float wallScale;",
          "uniform float roomLevel;",
          "uniform float lampLevel;",
          "uniform vec3 screenLight;",
          "uniform vec3 wallLight;",
        ].join("\n"),
      )
      .replace(
        "vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );",
        [
          "vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );",
          "\t\tlightMapTexel.rgb *= roomLevel;",
          "\t\tlightMapTexel.rgb += texture2D( lampLightMap, vLightMapUv ).rgb * lampLevel * lampScale;",
          "\t\tlightMapTexel.rgb += texture2D( screenLightMap, vLightMapUv ).rgb * screenLight * screenScale;",
          "\t\tlightMapTexel.rgb += texture2D( wallLightMap, vLightMapUv ).rgb * wallLight * wallScale;",
        ].join("\n"),
      );
    // three's shader text is not an API: fail loudly if an upgrade moves it.
    if (shader.fragmentShader.indexOf("wallLightMap, vLightMapUv") < 0) throw new Error("light map patch did not apply");
  };
  mat.customProgramCacheKey = function () {
    return "officeLight4";
  };
  return mat;
}

function need(value, what) {
  if (value === undefined || value === null || (typeof value === "number" && !isFinite(value))) {
    throw new Error("office model is missing " + what);
  }
  return value;
}

// Dresses the loaded model for drawing, in the page's room space (tube
// units, the desk terminal's tube centre at the origin, +Y up). `legends`
// are the textures legends.js drew for the keyboard: { keys, strip }.
export function buildOffice(loaded, legends) {
  var root = loaded.gltf.scene;
  var extras = root.userData || {};
  var unit = need(extras.tube_unit, "tube_unit");
  var ranges = {};
  ATLASES.forEach(function (name) {
    ranges[name] = {};
    PASSES.forEach(function (pass) {
      ranges[name][pass] = need(extras[pass + "_range_" + name], pass + "_range_" + name);
    });
  });

  function node(name) {
    return need(root.getObjectByName(name), name);
  }

  // The model is in metres. Scale it to tube units and move it so that the
  // terminal's TubeRef sits at the origin; the room keeps its vertical. The
  // terminal leans back, so the page's tube is turned to match TubeRef
  // (tubeQuaternion), not the room to match the tube.
  var tubeRef = node("TubeRef");
  root.updateMatrixWorld(true);
  var at = new Vector3().setFromMatrixPosition(tubeRef.matrixWorld);
  root.scale.setScalar(1 / unit);
  root.position.copy(at).multiplyScalar(-1 / unit);
  root.updateMatrixWorld(true);
  var tubeQuaternion = new Quaternion();
  tubeRef.matrixWorld.decompose(new Vector3(), tubeQuaternion, new Vector3());

  var light = {
    room: { value: 1 },
    lamp: { value: 1 },
    screen: { value: new Color(0, 0, 0) },
    wall: { value: new Color(0, 0, 0) },
  };
  var glows = [];
  var glowLamp = new Color();
  function applyGlows() {
    glows.forEach(function (g) {
      glowLamp.copy(g.on).sub(g.off).multiplyScalar(light.lamp.value);
      g.material.color.copy(g.off).multiplyScalar(light.room.value).add(glowLamp);
    });
  }
  var materials = [];
  function keep(mat) {
    materials.push(mat);
    return mat;
  }
  var baked = [];
  function lit(atlas, legend) {
    var maps = need(loaded.maps[atlas], "light maps for atlas " + atlas);
    var mat = keep(bakedMaterial(maps, ranges[atlas], light, legend));
    baked.push({ material: mat, atlas: atlas });
    return mat;
  }
  var plain = {};
  var keyed = null;
  var leds = {};
  var keyNodes = [];
  var meshes = [];
  var byName = {};

  root.traverse(function (o) {
    if (!o.isMesh) return;
    var x = o.userData || {};
    if (o.material && o.material.dispose) o.material.dispose();
    byName[o.name] = o;
    if (x.role === "led") {
      o.material = leds[o.name] = keep(new MeshBasicMaterial({ color: LED_OFF }));
    } else if (x.role === "emissive") {
      var e = x.emissive_radiance || need(x.emissive, "emissive colour of " + o.name);
      var peak = Math.max(e[0], e[1], e[2]) || 1;
      var glow = new Color(e[0] / peak, e[1] / peak, e[2] / peak).lerp(new Color(1, 1, 1), EMISSIVE_TOWARD_WHITE);
      o.material = keep(new MeshBasicMaterial({ color: glow }));
      var f = x.emissive_off || [0, 0, 0];
      glows.push({ material: o.material, on: glow.clone(), off: new Color(f[0], f[1], f[2]) });
    } else if (x.role === "backing") {
      o.material = keep(new MeshBasicMaterial({ color: 0x000000 }));
    } else {
      var atlas = need(x.atlas, "atlas of " + o.name);
      if (x.code !== undefined) {
        keyed = keyed || lit(atlas, legends.keys);
        o.material = keyed;
      } else if (o.name === "LegendStrip") {
        o.material = lit(atlas, legends.strip);
      } else {
        plain[atlas] = plain[atlas] || lit(atlas, null);
        o.material = plain[atlas];
      }
      meshes.push(o);
    }
    if (x.code !== undefined) keyNodes.push(o);
  });

  // The keys: each dips by its travel when its code is typed.
  var keys = keyNodes.map(function (n) {
    return { node: n, code: n.userData.code, rest: n.position.y, travel: n.userData.travel || 0, pos: 0, struck: 0, held: false };
  });
  var keyByCode = {};
  keys.forEach(function (k) {
    keyByCode[k.code] = k;
  });
  function keyFor(code) {
    return keyByCode[code] || keyByCode[KEY_STAND_INS[code]] || null;
  }

  // The terminal's own case, for the click that locks the view on it.
  var terminalCase = ["Collar", "Housing", "Plinth", "SideControls", "Nameplate", "NameplateText", "PowerButton"]
    .map(function (n) {
      return byName[n];
    })
    .filter(Boolean);
  var lampParts = ["Lamp_Base", "Lamp_Arm", "Lamp_Shade", "Lamp_ShadeGlow"]
    .map(function (n) {
      return byName[n];
    })
    .filter(Boolean);

  var office = {
    root: root,
    unit: unit,
    deskY: need(extras.desk_y, "desk_y"),
    tubeQuaternion: tubeQuaternion,
    meshes: meshes,
    terminalCase: terminalCase,
    lampParts: lampParts,
    wallSets: byName.Wall_Sets || null,
    // Light levels: 0..1 for the ceiling lights and the desk lamp; the
    // pictures' mean linear radiance (phosphor colour x mean level).
    setRoom: function (level) {
      light.room.value = level;
      applyGlows();
    },
    setLamp: function (level) {
      light.lamp.value = level;
      applyGlows();
    },
    setScreenLight: function (color) {
      light.screen.value.copy(color);
    },
    setWallLight: function (color) {
      light.wall.value.copy(color);
    },
    setMaps: function (maps) {
      baked.forEach(function (b) {
        b.material.userData.setMaps(maps[b.atlas]);
      });
    },
    setPowerLed: function (on) {
      if (leds.PowerLED) leds.PowerLED.color.set(on ? LED_ON : LED_OFF);
    },
    // The keyboard's keys, for clicks, and the code of one of them.
    keyMeshes: keyNodes,
    keyCode: function (mesh) {
      return mesh && mesh.userData ? mesh.userData.code : undefined;
    },
    // A key of the keyboard going down for a moment. True if it has one.
    pressKey: function (code) {
      var k = keyFor(code);
      if (!k) return false;
      k.struck = KEY_STRIKE_S;
      return true;
    },
    // A key held down (a key the real keyboard holds, or a Shift that was
    // clicked and waits for its key), or let go. True if it has one.
    holdKey: function (code, held) {
      var k = keyFor(code);
      if (!k || k.held === !!held) return !!k;
      k.held = !!held;
      return true;
    },
    // Moves the keys; true while any is moving.
    update: function (dt) {
      var moving = false;
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (k.struck > 0) {
          k.struck = Math.max(0, k.struck - dt);
          moving = true;
        }
        var goal = k.struck > 0 || k.held ? 1 : 0;
        if (k.pos === goal) continue;
        k.pos += (goal - k.pos) * (1 - Math.exp((-3 * dt) / (goal ? KEY_DOWN_S : KEY_UP_S)));
        if (Math.abs(goal - k.pos) < 0.01) k.pos = goal;
        else moving = true;
        k.node.position.y = k.rest - k.travel * k.pos;
      }
      return moving;
    },
    dispose: function () {
      root.traverse(function (o) {
        if (o.isMesh) o.geometry.dispose();
      });
      materials.forEach(function (m) {
        m.dispose();
      });
    },
  };
  return office;
}

// Where a point on the model's wall of sets is, as a monitor's column and
// row, given the wall's layout; null off the sets.
export function wallCellAt(point, layout) {
  var col = Math.round(point.x / layout.pitch[0] + (layout.columns - 1) / 2);
  var row = layout.rows - 1 - Math.round((point.y - (layout.monitors[layout.monitors.length - 1].y)) / layout.pitch[1]);
  if (col < 0 || col >= layout.columns || row < 0 || row >= layout.rows) return null;
  return { col: col, row: row };
}
