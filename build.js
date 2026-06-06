const fs   = require("fs");
const path = require("path");

const workerBase = process.env.WORKER_BASE;
if (!workerBase) {
  console.error("WORKER_BASE env var non impostata");
  process.exit(1);
}

const src  = path.join(__dirname, "app.js");
const out  = path.join(__dirname, "app.js");
const code = fs.readFileSync(src, "utf8");

if (!code.includes("__WORKER_BASE__")) {
  console.error("placeholder __WORKER_BASE__ non trovato in app.js");
  process.exit(1);
}

fs.writeFileSync(out, code.replaceAll("__WORKER_BASE__", workerBase));
console.log(`WORKER_BASE impostata ${workerBase}`);
