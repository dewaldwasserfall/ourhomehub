/**
 * Renders public/icons/icon.svg to the PNG sizes the PWA manifest and iOS need.
 * Run with: node scripts/render-icons.mjs  (uses the Playwright Chromium).
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const svg = readFileSync(path.join(root, "public/icons/icon.svg"), "utf8");

// name, size, rounded corners?, padding for maskable safe zone
const outputs = [
  ["icon-192.png", 192, false, 0],
  ["icon-512.png", 512, false, 0],
  ["icon-maskable-512.png", 512, false, 0],
  ["apple-touch-icon.png", 180, false, 0],
  ["icon-rounded-256.png", 256, true, 0],
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, rounded] of outputs) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">
       <div style="width:${size}px;height:${size}px;overflow:hidden;border-radius:${rounded ? size * 0.225 : 0}px">${svg.replace(
         "<svg ",
         `<svg width="${size}" height="${size}" `,
       )}</div></body></html>`,
  );
  await page.screenshot({ path: path.join(root, "public/icons", name), omitBackground: true });
}
await browser.close();
console.log("Rendered", outputs.length, "icons");
