// Injects exported data into the single-file build to produce a shareable,
// self-contained snapshot.html.
//
// Prereqs:
//   1. npm run build:snapshot                 -> dist-snapshot/index.html
//   2. serve --export > snapshot-data.json    -> the data to bake in
//   3. node scripts/make-snapshot.mjs         -> snapshot.html
//
// Usage: node scripts/make-snapshot.mjs [dataFile] [outFile]

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const htmlPath = "dist-snapshot/index.html";
const dataPath = process.argv[2] || "snapshot-data.json";
const outPath = process.argv[3] || "snapshot.html";

if (!existsSync(htmlPath)) {
  console.error(`Missing ${htmlPath}. Run: npm run build:snapshot`);
  process.exit(1);
}
if (!existsSync(dataPath)) {
  console.error(`Missing ${dataPath}. Run: serve --export > ${dataPath}`);
  process.exit(1);
}

const html = readFileSync(htmlPath, "utf8");
const data = readFileSync(dataPath, "utf8").trim();

// Escape anything that could break out of the <script> element or the JS string
// context: every "<" (covers </script>, <!--, and <script in the double-escaped
// tokenizer state), plus U+2028/U+2029 which are invalid in pre-ES2019 JS string
// literals. An escaped "<" is still valid JSON/JS and decodes to the same char.
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const safe = data
  .split("<")
  .join("\\u003c")
  .split(LS)
  .join("\\u2028")
  .split(PS)
  .join("\\u2029");
const inject = `<script>window.__CIPHER_SNAPSHOT__ = ${safe};</script>\n`;

const idx = html.indexOf("<script");
const out =
  idx >= 0
    ? html.slice(0, idx) + inject + html.slice(idx)
    : html.includes("</head>")
      ? html.replace("</head>", inject + "</head>")
      : html;

if (!out.includes("window.__CIPHER_SNAPSHOT__")) {
  console.error(`No injection point (<script or </head>) found in ${htmlPath}.`);
  process.exit(1);
}

writeFileSync(outPath, out);
console.log(`Wrote ${outPath} (${(out.length / 1024).toFixed(0)} KB)`);
