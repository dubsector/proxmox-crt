// Bundles the page into dist/. `--serve` rebuilds on change and serves dist/
// on http://localhost:8086 for development.
import { context, build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const serve = process.argv.includes("--serve");

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");
for (const name of ["index.html", "style.css", "favicon.svg"]) {
  cpSync(`client/${name}`, `dist/${name}`);
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
};

if (serve) {
  const ctx = await context(options);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: "dist", port: 8086 });
  console.log(`http://localhost:${port}/`);
} else {
  await build(options);
}
