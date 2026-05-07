// Drive the url/form → rc transform from the command line.
//
// Usage: node scripts/run-url-form-to-rc.js <path/to/handler.cfc>

const fs = require("fs");
const {
  rewriteUrlFormToRc
} = require("../out-test/src/transform/urlFormToRc");

const input = process.argv[2];
if (!input) {
  console.error("usage: node scripts/run-url-form-to-rc.js <handler.cfc>");
  process.exit(1);
}

const source = fs.readFileSync(input, "utf8");
const result = rewriteUrlFormToRc(source);

console.log("=== OUTPUT ===");
console.log(result.output);
console.log("=== STATS ===");
console.log("urlRewrites:", result.urlRewrites);
console.log("formRewrites:", result.formRewrites);
console.log("collisions:", result.collisions);
console.log("skippedFunctions:", result.skippedFunctions);
