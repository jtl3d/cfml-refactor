import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { extractQueriesFromFile } from "../src/index/extractFile";
import { extractQueryExecuteCalls } from "../src/index/extractScript";

const ROOT = path.join(__dirname, "fixtures", "phase5", "workspace1");
const ROOT_ALT = path.join(__dirname, "..", "..", "test", "fixtures", "phase5", "workspace1");

function fixtureRoot(): string {
  if (fs.existsSync(ROOT)) return ROOT;
  return ROOT_ALT;
}

function readFixture(rel: string): string {
  return fs.readFileSync(path.join(fixtureRoot(), rel), "utf8");
}

describe("index.extractFile", () => {
  it("extracts cfquery tags from a view", () => {
    const src = readFixture("views/users/list.cfm");
    const out = extractQueriesFromFile(src, {
      filePath: "views/users/list.cfm"
    });
    assert.strictEqual(out.length, 4);
    const names = out.map((q) => q.variableName);
    assert.deepStrictEqual(names, [
      "prc.users",
      "prc.permissions",
      "prc.recentLogins",
      "prc.loginCounts"
    ]);
    assert.strictEqual(out[0].context, "view");
    assert.strictEqual(out[0].source, "tag");
    assert.strictEqual(out[0].scope, "prc");
  });

  it("extracts queryExecute from cfscript inside a CFC", () => {
    const src = readFixture("handlers/UserHandler.cfc");
    const out = extractQueriesFromFile(src, {
      filePath: "handlers/UserHandler.cfc"
    });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].variableName, "prc.users");
    assert.strictEqual(out[0].source, "script");
    assert.strictEqual(out[0].context, "handler");
    assert.deepStrictEqual(out[0].tables, ["users"]);
    assert.deepStrictEqual(out[0].columns, ["id", "name"]);
    assert.deepStrictEqual(out[0].whereColumns, ["dept_id"]);
    assert.deepStrictEqual(out[0].paramTypes, ["cf_sql_integer"]);
  });

  it("returns no queries for a file with no SQL", () => {
    const src = readFixture("views/empty.cfm");
    const out = extractQueriesFromFile(src, { filePath: "views/empty.cfm" });
    assert.strictEqual(out.length, 0);
  });

  it("infers context from path", () => {
    const out = extractQueriesFromFile(readFixture("services/AuthService.cfc"), {
      filePath: "services/AuthService.cfc"
    });
    assert.strictEqual(out[0].context, "service");
  });

  it("infers unknown context for off-pattern paths", () => {
    const src = readFixture("handlers/UserHandler.cfc");
    const out = extractQueriesFromFile(src, {
      filePath: "lib/random/Thing.cfc"
    });
    assert.strictEqual(out[0].context, "unknown");
  });
});

describe("index.extractScript", () => {
  it("parses a basic queryExecute call with named params", () => {
    const body = `
      prc.x = queryExecute(
        "SELECT id FROM widgets WHERE id = :i",
        { i: { value: 1, cfsqltype: "cf_sql_integer" } }
      );
    `;
    const out = extractQueryExecuteCalls(body, 0);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].variableName, "prc.x");
    assert.strictEqual(out[0].rawSQL, "SELECT id FROM widgets WHERE id = :i");
    assert.deepStrictEqual(out[0].paramTypes, ["cf_sql_integer"]);
  });

  it("ignores queryExecute inside string literals or comments", () => {
    const body = `
      // foo = queryExecute("SELECT x FROM y", {});
      var s = "queryExecute('not real')";
    `;
    const out = extractQueryExecuteCalls(body, 0);
    assert.strictEqual(out.length, 0);
  });

  it("returns empty array for body without queryExecute substring", () => {
    const out = extractQueryExecuteCalls("var x = 1;\nvar y = 2;", 0);
    assert.strictEqual(out.length, 0);
  });

  it("handles concatenated string literals", () => {
    const body = `
      x = queryExecute("SELECT id " & "FROM users WHERE id = :i", { i: { value: 1, cfsqltype: "cf_sql_integer" } });
    `;
    const out = extractQueryExecuteCalls(body, 0);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(
      out[0].rawSQL,
      "SELECT id FROM users WHERE id = :i"
    );
  });
});
