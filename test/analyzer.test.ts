import * as assert from "assert";
import { analyze } from "../src/analyzer/findQueries";
import { parse } from "../src/parser/parse";
import { loadFixture } from "./helpers";

function run(fixture: string) {
  const src = loadFixture(fixture);
  return analyze(parse(src));
}

describe("analyzer.findQueries", () => {
  it("detects a plain top-level cfquery", () => {
    const result = run("plain-query.cfm");
    assert.strictEqual(result.queries.length, 1);
    const q = result.queries[0];
    assert.strictEqual(q.name, "getUsers");
    assert.strictEqual(q.context.insideLoop, false);
    assert.strictEqual(q.context.insideConditional, false);
    assert.strictEqual(q.hasConditionalSQL, false);
    assert.strictEqual(q.qparams.length, 2);
    assert.deepStrictEqual(
      q.qparams.map((p) => p.name),
      ["deptId", "status"]
    );
    assert.strictEqual(q.datasource, "appdb");
  });

  it("detects cfquery inside a query loop", () => {
    const result = run("query-in-query-loop.cfm");
    assert.strictEqual(result.queries.length, 2);
    const inner = result.queries.find((q) => q.name === "getOrders");
    assert.ok(inner);
    assert.strictEqual(inner.context.insideLoop, true);
    assert.strictEqual(inner.context.loopType, "query");
    assert.strictEqual(inner.context.loopQueryName, "getUsers");
    assert.strictEqual(inner.hasConditionalSQL, true);
  });

  it("detects cfquery inside a from/to loop", () => {
    const result = run("query-in-from-loop.cfm");
    assert.strictEqual(result.queries.length, 1);
    const q = result.queries[0];
    assert.strictEqual(q.context.insideLoop, true);
    assert.strictEqual(q.context.loopType, "from-to");
  });

  it("flags conditional SQL when cfif appears in body", () => {
    const result = run("query-with-conditional.cfm");
    assert.strictEqual(result.queries.length, 1);
    assert.strictEqual(result.queries[0].hasConditionalSQL, true);
  });

  it("excludes Query of Queries (dbtype=\"query\")", () => {
    const result = run("qoq.cfm");
    assert.strictEqual(result.queries.length, 1);
    assert.strictEqual(result.queries[0].name, "getUsers");
    assert.strictEqual(result.skipped.length, 1);
    assert.strictEqual(result.skipped[0].reason, "qoq");
  });

  it("does not detect queries inside cfscript (Phase 1)", () => {
    const result = run("query-in-script.cfm");
    assert.strictEqual(result.queries.length, 0);
    assert.strictEqual(result.cfscriptBlocks, 1);
  });

  it("handles a mixed file with HTML and cfscript islands", () => {
    const result = run("mixed.cfm");
    const names = result.queries.map((q) => q.name);
    assert.deepStrictEqual(names, ["getUsers", "getCount"]);
    assert.strictEqual(result.cfscriptBlocks, 1);
  });

  it("skips queries marked with @cfml-refactor:skip", () => {
    const result = run("magic-skip.cfm");
    const names = result.queries.map((q) => q.name);
    assert.deepStrictEqual(names, ["keepMe", "alsoKeep"]);
    assert.strictEqual(result.skipped.length, 1);
    assert.strictEqual(result.skipped[0].reason, "magic-comment");
    assert.strictEqual(result.skipped[0].name, "ignoreMe");
  });

  it("captures the SQL body verbatim", () => {
    const result = run("plain-query.cfm");
    const body = result.queries[0].sqlBody;
    assert.ok(body.includes("SELECT id, name"));
    assert.ok(body.includes("FROM users"));
  });
});
