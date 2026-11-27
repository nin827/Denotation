// Bundles public/ into single-file pages (only needed if the Claude artifact is still wanted):
//   dist/denotion.html             artifact fragment (no <html>/<head>/<body>; the artifact host wraps it)
//   dist/denotion.standalone.html  complete page that opens from disk
// usage: node build/artifact.mjs [--minify]   (ESBUILD_PATH=<esbuild package dir> to use a preinstalled esbuild)
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const { build } = await import(process.env.ESBUILD_PATH ? pathToFileURL(process.env.ESBUILD_PATH + "/lib/main.js").href : "esbuild");

const result = await build({
  entryPoints: ["public/js/app.js"],
  bundle: true,
  format: "iife",
  target: "es2022",
  write: false,
  minify: process.argv.includes("--minify"),
  legalComments: "none",
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const css = fs.readFileSync("public/css/style.css", "utf8");
const page = fs
  .readFileSync("public/index.html", "utf8")
  .replace(/\s*<link rel="stylesheet" href="css\/style.css">/, () => `\n  <style>\n${css}</style>`)
  .replace(/<script type="module" src="js\/app.js"><\/script>/, () => `<script>\n${js}</script>`);

const body = page.match(/<body>\n?([\s\S]*)<\/body>/)[1];
const fragment = [
  page.match(/<title>.*<\/title>/)[0],
  page.match(/<meta name="claude:viewport-fit-sides"[^>]*>/)[0],
  `<style>\n${css}</style>`,
  body.trim(),
].join("\n") + "\n";

fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/denotion.standalone.html", page);
fs.writeFileSync("dist/denotion.html", fragment);
console.log(`dist/denotion.html ${(fragment.length / 1024).toFixed(1)} KB, dist/denotion.standalone.html ${(page.length / 1024).toFixed(1)} KB`);
