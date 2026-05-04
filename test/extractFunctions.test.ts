import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { extractFunctionsFromFile } from "../src/index/extractFunctions";

const ROOT = path.join(__dirname, "fixtures", "phase5", "workspace1");
const ROOT_ALT = path.join(
  __dirname,
  "..",
  "..",
  "test",
  "fixtures",
  "phase5",
  "workspace1"
);

function fixtureRoot(): string {
  return fs.existsSync(ROOT) ? ROOT : ROOT_ALT;
}

function read(rel: string): string {
  return fs.readFileSync(path.join(fixtureRoot(), rel), "utf8");
}

describe("index.extractFunctions", () => {
  it("extracts a tag-style cffunction from a handler CFC", () => {
    const out = extractFunctionsFromFile(read("handlers/UserHandler.cfc"), {
      filePath: "handlers/UserHandler.cfc",
      context: "handler"
    });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].name, "getUsers");
    assert.deepStrictEqual(out[0].argumentList, ["deptId"]);
    assert.strictEqual(out[0].context, "handler");
    assert.strictEqual(out[0].isPublic, true);
  });

  it("extracts script-style functions from a service CFC", () => {
    const src = `
      component {
        public any function getActiveUsers(numeric deptId = 0) {
          return queryExecute("SELECT 1 FROM dual");
        }
        private string function describe(string name) {
          return ucase(name);
        }
      }
    `;
    const out = extractFunctionsFromFile(src, {
      filePath: "services/Test.cfc",
      context: "service"
    });
    const names = out.map((f) => f.name).sort();
    assert.deepStrictEqual(names, ["describe", "getActiveUsers"]);
    const getActive = out.find((f) => f.name === "getActiveUsers");
    assert.ok(getActive);
    assert.deepStrictEqual(getActive.argumentList, ["deptId"]);
    assert.strictEqual(getActive.isPublic, true);
    const describe = out.find((f) => f.name === "describe");
    assert.ok(describe);
    assert.strictEqual(describe.isPublic, false);
  });
});
