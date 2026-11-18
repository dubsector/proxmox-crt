// Writes the office's layout (client/layout.js) as JSON for the Blender
// scripts that model and bake the room:
//
//   node tools/office-layout.mjs > tools/blender/layout.json
import { officeLayout } from "../client/layout.js";

process.stdout.write(JSON.stringify(officeLayout(), null, 1) + "\n");
