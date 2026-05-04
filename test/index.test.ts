import * as assert from "assert";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  buildFingerprintMap,
  loadIndex,
  removeFileFromIndex,
  saveIndex,
  scanWorkspace,
  updateIndexForFile
} from "../src/index/indexer";
import { findMatches, findMatchesForFile } from "../src/index/match";
import type { IndexFile } from "../src/index/types";

const ROOT = path.join(__dirname, "fixtures", "phase5", "workspace1");
const ROOT_ALT = path.join(__dirname, "..", "..", "test", "fixtures", "phase5", "workspace1");

function fixtureRoot(): string {
  if (fs.existsSync(ROOT)) return ROOT;
  return ROOT_ALT;
}

let scanned: IndexFile;

describe("index.indexer (workspace1)", () => {
  before(async () => {
    const result = await scanWorkspace(fixtureRoot());
    scanned = result.index;
  });

  it("scans all 6 files and finds the expected total queries", () => {
    const counts = {
      "views/users/list.cfm": 4,
      "views/admin/userList.cfm": 1,
      "handlers/UserHandler.cfc": 1,
      "services/AuthService.cfc": 1,
      "views/orders/list.cfm": 1,
      "views/empty.cfm": 0
    };
    for (const [file, expected] of Object.entries(counts)) {
      const actual = scanned.queries.filter((q) => q.filePath === file).length;
      assert.strictEqual(actual, expected, `count for ${file}`);
    }
    assert.strictEqual(scanned.queries.length, 8);
  });

  it("groups identical SELECT id, name FROM users WHERE dept_id = ? across 3 files", () => {
    const usersQueries = scanned.queries.filter(
      (q) =>
        q.tables.length === 1 &&
        q.tables[0].toLowerCase() === "users" &&
        q.columns.length === 2 &&
        q.whereColumns.length === 1 &&
        q.whereColumns[0] === "dept_id"
    );
    assert.strictEqual(usersQueries.length, 3);
    const fingerprints = new Set(usersQueries.map((q) => q.sqlFingerprint));
    assert.strictEqual(fingerprints.size, 1, "all three should share fingerprint");
  });

  it("fingerprintMap is consistent with queries[]", () => {
    const rebuilt = buildFingerprintMap(scanned.queries);
    assert.deepStrictEqual(rebuilt, scanned.fingerprintMap);
  });

  it("EXACT matches surface for prc.users in views/users/list.cfm", () => {
    const target = scanned.queries.find(
      (q) =>
        q.filePath === "views/users/list.cfm" && q.variableName === "prc.users"
    );
    assert.ok(target);
    const matches = findMatches(target, scanned);
    const exact = matches.filter((m) => m.type === "EXACT");
    assert.strictEqual(exact.length, 2);
    const files = exact.map((m) => m.query.filePath).sort();
    assert.deepStrictEqual(files, [
      "handlers/UserHandler.cfc",
      "views/admin/userList.cfm"
    ]);
  });

  it("EXACT matches work across cfquery and queryExecute syntax", () => {
    const cfqueryUsers = scanned.queries.find(
      (q) =>
        q.filePath === "views/users/list.cfm" && q.variableName === "prc.users"
    );
    const scriptUsers = scanned.queries.find(
      (q) =>
        q.filePath === "handlers/UserHandler.cfc" &&
        q.variableName === "prc.users"
    );
    assert.ok(cfqueryUsers && scriptUsers);
    assert.strictEqual(cfqueryUsers.sqlFingerprint, scriptUsers.sqlFingerprint);
  });

  it("STRUCTURAL match (different ORDER BY) surfaces between AuthService and views/users/list", () => {
    const target = scanned.queries.find(
      (q) =>
        q.filePath === "views/users/list.cfm" &&
        q.variableName === "prc.permissions"
    );
    assert.ok(target);
    const matches = findMatches(target, scanned);
    const struct = matches.filter((m) => m.type === "STRUCTURAL");
    assert.strictEqual(struct.length, 1);
    assert.strictEqual(struct[0].query.filePath, "services/AuthService.cfc");
  });

  it("queries with no matches return zero matches", () => {
    const target = scanned.queries.find(
      (q) => q.filePath === "views/orders/list.cfm"
    );
    assert.ok(target);
    const matches = findMatches(target, scanned);
    assert.strictEqual(matches.length, 0);
  });

  it("does not surface TABLE-OVERLAP by default", () => {
    const target = scanned.queries.find(
      (q) =>
        q.filePath === "views/users/list.cfm" &&
        q.variableName === "prc.recentLogins"
    );
    assert.ok(target);
    const matches = findMatches(target, scanned);
    const overlap = matches.filter((m) => m.type === "TABLE-OVERLAP");
    assert.strictEqual(overlap.length, 0);
  });

  it("surfaces TABLE-OVERLAP when configured", () => {
    const target = scanned.queries.find(
      (q) =>
        q.filePath === "views/users/list.cfm" &&
        q.variableName === "prc.recentLogins"
    );
    assert.ok(target);
    const matches = findMatches(target, scanned, { includeTableOverlap: true });
    const overlap = matches.filter((m) => m.type === "TABLE-OVERLAP");
    assert.strictEqual(overlap.length, 1);
    assert.strictEqual(overlap[0].query.variableName, "prc.loginCounts");
  });

  it("findMatchesForFile returns matches per query in target file", () => {
    const sections = findMatchesForFile("views/users/list.cfm", scanned);
    assert.strictEqual(sections.length, 4);
    const usersSection = sections.find(
      (s) => s.query.variableName === "prc.users"
    );
    assert.ok(usersSection);
    assert.ok(usersSection.matches.some((m) => m.type === "EXACT"));
    const ordersSection = sections.find(
      (s) => s.query.variableName === "prc.recentLogins"
    );
    assert.ok(ordersSection);
    assert.strictEqual(ordersSection.matches.length, 0);
  });

  it("sorts matches by type then context preference (handler before view)", () => {
    const target = scanned.queries.find(
      (q) =>
        q.filePath === "views/users/list.cfm" && q.variableName === "prc.users"
    );
    assert.ok(target);
    const matches = findMatches(target, scanned);
    assert.strictEqual(matches[0].query.context, "handler");
  });
});

describe("index.indexer persistence and incremental updates", () => {
  let tmp: string;

  before(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cfml-refactor-test-"));
    await copyDir(fixtureRoot(), tmp);
  });

  after(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("saves and reloads the index", async () => {
    const result = await scanWorkspace(tmp);
    await saveIndex(tmp, result.index);
    const loaded = await loadIndex(tmp);
    assert.ok(loaded);
    assert.strictEqual(loaded.queries.length, result.index.queries.length);
    assert.deepStrictEqual(loaded.fingerprintMap, result.index.fingerprintMap);
  });

  it("adds the index path to .gitignore", async () => {
    const text = await fsp.readFile(path.join(tmp, ".gitignore"), "utf8");
    assert.ok(text.includes(".vscode/cfml-refactor-index.json"));
  });

  it("incremental update replaces queries for one file only", async () => {
    const result = await scanWorkspace(tmp);
    const targetAbs = path.join(tmp, "views/orders/list.cfm");
    const newSrc = `<cfquery name="prc.orders" datasource="appdb">
      SELECT id, total, status FROM orders WHERE customer_id = <cfqueryparam value="1" cfsqltype="cf_sql_integer">
    </cfquery>`;
    await fsp.writeFile(targetAbs, newSrc, "utf8");
    const updated = updateIndexForFile(result.index, tmp, targetAbs, newSrc);
    const ordersQueries = updated.queries.filter(
      (q) => q.filePath === "views/orders/list.cfm"
    );
    assert.strictEqual(ordersQueries.length, 1);
    assert.deepStrictEqual(ordersQueries[0].columns, ["id", "total", "status"]);
    assert.strictEqual(updated.queries.length, result.index.queries.length);
  });

  it("removeFileFromIndex drops queries for that file", async () => {
    const result = await scanWorkspace(tmp);
    const before = result.index.queries.length;
    const updated = removeFileFromIndex(
      result.index,
      tmp,
      path.join(tmp, "views/orders/list.cfm")
    );
    assert.ok(updated.queries.length < before);
    assert.strictEqual(
      updated.queries.filter((q) => q.filePath === "views/orders/list.cfm").length,
      0
    );
  });

  it("excludes node_modules and other excluded directories", async () => {
    await fsp.mkdir(path.join(tmp, "node_modules", "foo"), { recursive: true });
    await fsp.writeFile(
      path.join(tmp, "node_modules", "foo", "garbage.cfm"),
      `<cfquery name="x" datasource="appdb">SELECT 1 FROM dual</cfquery>`,
      "utf8"
    );
    const result = await scanWorkspace(tmp);
    assert.strictEqual(
      result.index.queries.filter((q) => q.filePath.includes("node_modules"))
        .length,
      0
    );
  });
});

async function copyDir(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else await fsp.copyFile(s, d);
  }
}
