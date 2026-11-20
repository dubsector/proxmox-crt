// The switch in a lamp's cord, lying on the desk: the old in-line kind, a
// small black bakelite case with the rim of a toothed thumbwheel showing
// through a slot in it. A
// click rolls the wheel on a notch, and the lamp is on or off.
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { Group, Mesh, BoxGeometry, CylinderGeometry, ExtrudeGeometry, TubeGeometry, CatmullRomCurve3, Shape, Vector3, MeshStandardMaterial } from "three";

var TEETH = 14;
var NOTCH = (Math.PI * 2) / TEETH;
var ROLL_S = 0.07;
// In tube units of about 61 mm: a case 50 mm long, 18 thick and 26 deep,
// and a wheel that stands 3 mm out of it.
var BODY = { l: 0.82, w: 0.3, h: 0.42 };
var WHEEL = { r: 0.13, w: 0.07, out: 0.05 };
// It is drawn a little under life size, which is how small it looks
// beside a lamp.
var SIZE = 0.6;
var CORD_R = 0.028;

// The wheel seen from its side: a disc with teeth round it.
function wheelShape(radius, tooth) {
  var shape = new Shape();
  for (var t = 0; t < TEETH * 4; t++) {
    var a = (t / (TEETH * 4)) * Math.PI * 2;
    // Two points out and two in for each tooth, so they are square-cut.
    var r = t % 4 < 2 ? radius : radius - tooth;
    if (t) shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    else shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  shape.closePath();
  return shape;
}

// A cord lying along these points, as one smooth run.
function cordGeometry(points) {
  var curve = new CatmullRomCurve3(points, false, "centripetal");
  return new TubeGeometry(curve, points.length * 14, CORD_R, 6, false);
}

// options: { x, y: the desk top, z, turn, fromLamp: [[x, z]] the way the
// cord comes across the desk from the lamp's base to the switch, toWall:
// [[x, z]] the way it goes on from the switch, the last being where it
// drops over the desk's back edge }
export function createCordSwitch(options) {
  var group = new Group();
  group.position.y = options.y;
  var bakelite = new MeshStandardMaterial({ color: 0x121110, roughness: 0.3 });
  var seamMat = new MeshStandardMaterial({ color: 0x050505, roughness: 0.6 });
  var ivory = new MeshStandardMaterial({ color: 0xd8cfae, roughness: 0.5 });
  var steel = new MeshStandardMaterial({ color: 0x9a9995, roughness: 0.3, metalness: 0.7 });
  var bodyGeo = new RoundedBoxGeometry(BODY.w, BODY.h, BODY.l, 3, 0.06);
  var seamGeo = new BoxGeometry(0.012, BODY.h + 0.004, BODY.l + 0.004);
  var rivetGeo = new CylinderGeometry(0.035, 0.035, BODY.w + 0.02, 10);
  var wheelGeo = new ExtrudeGeometry(wheelShape(WHEEL.r, 0.018), { depth: WHEEL.w, bevelEnabled: false, curveSegments: 1 });
  wheelGeo.translate(0, 0, -WHEEL.w / 2);

  // The body runs along the cord, which is the switch's Z.
  var body = new Mesh(bodyGeo, bakelite);
  body.position.y = BODY.h / 2;
  // The two halves of the case meet along its middle.
  var seam = new Mesh(seamGeo, seamMat);
  seam.position.y = BODY.h / 2;
  var rivet = new Mesh(rivetGeo, steel);
  rivet.rotation.z = Math.PI / 2;
  rivet.position.set(0, BODY.h * 0.42, 0.05);
  // The wheel turns on an axle across the body, and only its rim shows
  // through the slot in the top.
  var wheel = new Mesh(wheelGeo, ivory);
  wheel.position.set(0, BODY.h - WHEEL.r + WHEEL.out, -BODY.l * 0.12);
  wheel.rotation.y = Math.PI / 2;
  // It lies on its side, as it falls, so the wheel shows at one edge.
  var lying = new Group();
  lying.rotation.z = Math.PI / 2;
  lying.position.set(BODY.h / 2, BODY.w / 2, 0);
  lying.add(body, seam, rivet, wheel);
  var placed = new Group();
  placed.position.set(options.x, 0, options.z);
  placed.rotation.y = options.turn || 0;
  placed.scale.setScalar(SIZE);
  placed.add(lying);
  group.add(placed);

  // One cord: from the lamp's base across the desk into the middle of one
  // end of the switch, out of the middle of the other, and away over the
  // desk's back edge to the wall.
  var turn = options.turn || 0;
  var along = { x: Math.sin(turn), z: Math.cos(turn) };
  var half = (BODY.l / 2) * SIZE;
  var mid = (BODY.w / 2) * SIZE;
  function at(x, z, y) {
    return new Vector3(x, y === undefined ? CORD_R : y, z);
  }
  function end(side, out, y) {
    return at(options.x + along.x * side * (half + out), options.z + along.z * side * (half + out), y);
  }
  var lampRun = (options.fromLamp || []).map(function (p) {
    return at(p[0], p[1]);
  });
  // It comes down off the switch's middle to the desk within a finger's width.
  lampRun.push(end(-1, 0.45), end(-1, 0.12, mid * 0.8), end(-1, -0.03, mid));
  var wallRun = [end(1, -0.03, mid), end(1, 0.12, mid * 0.8), end(1, 0.45)].concat(
    (options.toWall || []).map(function (p) {
      return at(p[0], p[1]);
    }),
  );
  var edge = wallRun[wallRun.length - 1];
  wallRun.push(at(edge.x, edge.z - 0.12, -0.1), at(edge.x, edge.z - 0.16, -1.2), at(edge.x, edge.z - 0.16, -6));
  var cordGeos = [cordGeometry(lampRun), cordGeometry(wallRun)];
  var cords = cordGeos.map(function (geometry) {
    var m = new Mesh(geometry, seamMat);
    group.add(m);
    return m;
  });

  var on = true;
  var angle = 0;
  var goal = 0;

  return {
    group: group,
    // The cords, which a baked room draws for itself.
    shell: cords,
    // What takes the click.
    pickables: [body, wheel],
    set: function (to) {
      if (!!to === on) return;
      on = !!to;
      goal += NOTCH * 2;
    },
    // Rolls the wheel on by dt seconds. True while it is turning.
    update: function (dt, still) {
      if (angle === goal) return false;
      angle = still || Math.abs(goal - angle) < 0.004 ? goal : angle + (goal - angle) * (1 - Math.exp(-dt / ROLL_S));
      wheel.rotation.x = angle;
      return true;
    },
    dispose: function () {
      [bakelite, seamMat, ivory, steel, bodyGeo, seamGeo, rivetGeo, wheelGeo].concat(cordGeos).forEach(function (o) {
        o.dispose();
      });
    },
  };
}
