// Drive the cfm → handler transform from the command line so we can eyeball
// the output without launching a VS Code extension host.
//
// Usage: node scripts/run-cfm-to-handler.js <path/to/input.cfm>

const fs = require("fs");
const path = require("path");
const {
  convertCfmToHandler,
  buildHandlerFile
} = require("../out-test/src/transform/convertCfmToHandler");

const input = process.argv[2];
if (!input) {
  console.error("usage: node scripts/run-cfm-to-handler.js <input.cfm>");
  process.exit(1);
}

const source = fs.readFileSync(input, "utf8");
const baseName = path.basename(input, path.extname(input));
const opts = {
  actionName: baseName.toLowerCase().replace(/[-_]/g, ""),
  viewPath: `${baseName}/${baseName.toLowerCase().replace(/[-_]/g, "")}`,
  scopeStyle: "var",
  tabUnit: "    "
};
const result = convertCfmToHandler(source, opts);

const handler = buildHandlerFile(
  result.handlerBody,
  result.setViewCall,
  opts.actionName,
  opts.tabUnit
);

console.log("=== HANDLER ===");
console.log(handler);
console.log("=== VIEW (" + (result.hasView ? "yes" : "none") + ") ===");
console.log(result.viewBody);
console.log("=== STATS ===");
console.log("tagsConverted:", result.tagsConverted);
console.log("todos:", result.todos);
console.log("rescoped:", result.rescoped);
console.log("querySkipped:", result.querySkipped);
