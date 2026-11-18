// Bundles the page into dist/. `--serve` rebuilds on change and serves dist/
// on http://localhost:8086 for development.
import { context, build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const serve = process.argv.includes("--serve");

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");
for (const name of ["index.html", "style.css", "favicon.svg"]) {
  cpSync(`client/${name}`, `dist/${name}`);
}

// The baked office (tools/blender/build_office.py writes it into
// client/assets): fetched by the page at run time, not bundled. Each file
// goes out under a name with a hash of its content in it, so a new bake is
// picked up at once; the page gets the names through __ASSETS__. With no
// bake the page keeps its grey-box room.
mkdirSync("dist/assets");
const assets = { files: {}, sizes: [] };
if (existsSync("client/assets")) {
  for (const name of readdirSync("client/assets").sort()) {
    if (!/\.(glb|webp)$/.test(name)) continue;
    const data = readFileSync(`client/assets/${name}`);
    const dot = name.indexOf(".");
    const hash = createHash("sha256").update(data).digest("hex").slice(0, 10);
    assets.files[name] = `${name.slice(0, dot)}.${hash}${name.slice(dot)}`;
    writeFileSync(`dist/assets/${assets.files[name]}`, data);
    const size = /^lm_[a-z]+_[a-z]+_(\d+)\.webp$/.exec(name);
    if (size && !assets.sizes.includes(+size[1])) assets.sizes.push(+size[1]);
  }
  assets.sizes.sort((a, b) => a - b);
}

const options = {
  entryPoints: ["client/main.js"],
  bundle: true,
  format: "esm",
  target: "es2020",
  outfile: "dist/main.js",
  minify: !serve,
  sourcemap: serve,
  logLevel: "info",
  define: { __ASSETS__: JSON.stringify(assets) },
};

if (serve) {
  const ctx = await context(options);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: "dist", port: 8086 });
  console.log(`http://localhost:${port}/`);
} else {
  await build(options);
}
