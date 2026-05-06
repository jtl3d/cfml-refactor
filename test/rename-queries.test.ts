import * as assert from "assert";
import {
  findEnclosingFunctionRange,
  findQueryExecuteAssignments,
  renameQueriesInSource
} from "../src/transform/renameQueries";

describe("renameQueries: findQueryExecuteAssignments", () => {
  it("finds bare assignment", () => {
    const src = `<cfscript>\n  getUsers = queryExecute("SELECT 1", {}, {});\n</cfscript>\n`;
    const found = findQueryExecuteAssignments(src);
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].target, "getUsers");
    assert.strictEqual(found[0].baseName, "getUsers");
  });

  it("finds scope-qualified assignment", () => {
    const src = `<cfscript>\n  local.getUsers = queryExecute("SELECT 1", {}, {});\n</cfscript>\n`;
    const found = findQueryExecuteAssignments(src);
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].target, "local.getUsers");
    assert.strictEqual(found[0].baseName, "getUsers");
  });

  it("finds var-declared assignment", () => {
    const src = `<cfscript>\n  var getUsers = queryExecute("SELECT 1", {}, {});\n</cfscript>\n`;
    const found = findQueryExecuteAssignments(src);
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].target, "getUsers");
    assert.strictEqual(found[0].baseName, "getUsers");
  });

  it("skips already-prc-prefixed assignments", () => {
    const src = `<cfscript>\n  prc.getUsers = queryExecute("SELECT 1", {}, {});\n</cfscript>\n`;
    const found = findQueryExecuteAssignments(src);
    assert.strictEqual(found.length, 0);
  });
});

describe("renameQueries: findEnclosingFunctionRange", () => {
  it("returns the body range for a position inside a function", () => {
    const src =
      `<cfscript>\n` +
      `function loadUsers() {\n` +
      `    var u = queryExecute("SELECT 1", {}, {});\n` +
      `    return u;\n` +
      `}\n` +
      `</cfscript>\n`;
    const callPos = src.indexOf("queryExecute");
    const range = findEnclosingFunctionRange(src, callPos);
    assert.ok(range, "expected a range");
    assert.ok(range!.start < callPos);
    assert.ok(range!.end > callPos);
  });

  it("returns undefined for top-level position", () => {
    const src = `<cfscript>\n  getUsers = queryExecute("SELECT 1", {}, {});\n</cfscript>\n`;
    const callPos = src.indexOf("queryExecute");
    assert.strictEqual(findEnclosingFunctionRange(src, callPos), undefined);
  });
});

describe("renameQueries: renameQueriesInSource", () => {
  it("renames bare assignment and references", () => {
    const src =
      `<cfscript>\n` +
      `  getUsers = queryExecute("SELECT id FROM users", {}, {});\n` +
      `</cfscript>\n` +
      `<cfif getUsers.recordCount GT 0>\n` +
      `  <cfoutput query="getUsers"><p>#getUsers.name#</p></cfoutput>\n` +
      `</cfif>\n`;
    const result = renameQueriesInSource(src);
    assert.strictEqual(result.renamed.length, 1);
    assert.strictEqual(result.renamed[0].replacement, "prc.getUsers");
    assert.match(result.output, /prc\.getUsers = queryExecute/);
    assert.match(result.output, /<cfif prc\.getUsers\.recordCount/);
    assert.match(result.output, /<cfoutput query="prc\.getUsers">/);
    assert.match(result.output, /#prc\.getUsers\.name#/);
  });

  it("renames scope-qualified assignment", () => {
    const src =
      `<cfscript>\n` +
      `  local.getUsers = queryExecute("SELECT id FROM users", {}, {});\n` +
      `</cfscript>\n` +
      `<cfif local.getUsers.recordCount GT 0>\n` +
      `  <p>#local.getUsers.name#</p>\n` +
      `</cfif>\n`;
    const result = renameQueriesInSource(src);
    assert.strictEqual(result.renamed.length, 1);
    assert.match(result.output, /prc\.getUsers = queryExecute/);
    assert.match(result.output, /<cfif prc\.getUsers\.recordCount/);
    assert.match(result.output, /#prc\.getUsers\.name#/);
  });

  it("does not touch SQL inside the queryExecute string", () => {
    const src =
      `<cfscript>\n` +
      `  getUsers = queryExecute("SELECT getUsers FROM something", {}, {});\n` +
      `</cfscript>\n`;
    const result = renameQueriesInSource(src);
    assert.strictEqual(result.renamed.length, 1);
    // Outer assignment renamed; SQL string contents preserved.
    assert.match(result.output, /prc\.getUsers = queryExecute/);
    assert.match(result.output, /"SELECT getUsers FROM something"/);
  });

  it("skips assignments already prefixed with prc.", () => {
    const src =
      `<cfscript>\n` +
      `  prc.getUsers = queryExecute("SELECT 1", {}, {});\n` +
      `</cfscript>\n`;
    const result = renameQueriesInSource(src);
    assert.strictEqual(result.renamed.length, 0);
    assert.strictEqual(result.output, src);
  });

  it("scopes rename to enclosing function body", () => {
    const src =
      `<cfscript>\n` +
      `function loadA() {\n` +
      `    var data = queryExecute("SELECT 1", {}, {});\n` +
      `    return data;\n` +
      `}\n` +
      `\n` +
      `function loadB() {\n` +
      `    var data = "unrelated string";\n` +
      `    return data;\n` +
      `}\n` +
      `</cfscript>\n`;
    const result = renameQueriesInSource(src);
    assert.strictEqual(result.renamed.length, 1);
    // Assignment + the `return data;` inside loadA should be renamed.
    assert.match(result.output, /prc\.data = queryExecute/);
    assert.match(result.output, /loadA\(\) \{[\s\S]*return prc\.data;/);
    // loadB's `data` must stay alone — different scope.
    assert.match(result.output, /loadB\(\) \{\s*var data = "unrelated string";\s*return data;/);
  });

  it("is a no-op when there are no queryExecute assignments", () => {
    const src = `<cfscript>\n  var x = 1;\n</cfscript>\n`;
    const result = renameQueriesInSource(src);
    assert.strictEqual(result.renamed.length, 0);
    assert.strictEqual(result.output, src);
  });

  it("renames multiple assignments in one file", () => {
    const src =
      `<cfscript>\n` +
      `  getUsers = queryExecute("SELECT 1", {}, {});\n` +
      `  getOrders = queryExecute("SELECT 2", {}, {});\n` +
      `</cfscript>\n` +
      `<cfif getUsers.recordCount AND getOrders.recordCount>OK</cfif>\n`;
    const result = renameQueriesInSource(src);
    assert.strictEqual(result.renamed.length, 2);
    assert.match(result.output, /prc\.getUsers = queryExecute/);
    assert.match(result.output, /prc\.getOrders = queryExecute/);
    assert.match(
      result.output,
      /<cfif prc\.getUsers\.recordCount AND prc\.getOrders\.recordCount>/
    );
  });
});
