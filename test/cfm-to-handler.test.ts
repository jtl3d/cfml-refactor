import * as assert from "assert";
import { convertCfmToHandler } from "../src/transform/convertCfmToHandler";

const baseOpts = {
  actionName: "index",
  viewPath: "main/index",
  scopeStyle: "var" as const,
  tabUnit: "    "
};

describe("convertCfmToHandler: view detection", () => {
  it("creates a view when a cfoutput renders markup", () => {
    const src =
      `<cfquery name="getUsers" datasource="db">\n` +
      `    SELECT id, name FROM users\n` +
      `</cfquery>\n` +
      `<cfoutput>\n` +
      `    <cfloop query="getUsers">\n` +
      `        <div>#getUsers.name#</div>\n` +
      `    </cfloop>\n` +
      `</cfoutput>\n`;
    const result = convertCfmToHandler(src, baseOpts);
    assert.strictEqual(result.hasView, true);
    assert.match(result.viewBody, /<div>/);
    assert.match(result.viewBody, /<cfoutput>/);
    assert.match(result.handlerBody, /queryExecute/);
    assert.ok(result.setViewCall);
  });

  it("routes a markup-bearing cfif to the view", () => {
    const src =
      `<cfset msg = "hi">\n` +
      `<cfif len(msg)>\n` +
      `    <p><cfoutput>#msg#</cfoutput></p>\n` +
      `</cfif>\n`;
    const result = convertCfmToHandler(src, baseOpts);
    assert.strictEqual(result.hasView, true);
    assert.match(result.viewBody, /<cfif/);
    assert.match(result.viewBody, /<p>/);
  });

  it("reports pure logic when there is no markup", () => {
    const src =
      `<cfset a = 1>\n` +
      `<cfset b = 2>\n` +
      `<cfset c = a + b>\n`;
    const result = convertCfmToHandler(src, baseOpts);
    assert.strictEqual(result.hasView, false);
    assert.strictEqual(result.viewBody, "");
  });

  it("scopes a query used by the view through prc", () => {
    const src =
      `<cfquery name="getUsers" datasource="db">\n` +
      `    SELECT id FROM users\n` +
      `</cfquery>\n` +
      `<cfoutput>\n` +
      `    <cfloop query="getUsers">#getUsers.id#</cfloop>\n` +
      `</cfoutput>\n`;
    const result = convertCfmToHandler(src, baseOpts);
    assert.match(result.handlerBody, /prc\.getUsers = queryExecute/);
    assert.match(result.viewBody, /query="prc\.getUsers"/);
    assert.match(result.viewBody, /#prc\.getUsers\.id#/);
  });

  it("converts queries nested inside display markup into the handler", () => {
    const src =
      `<cfquery name="getCats" datasource="db">\n` +
      `    SELECT id, name FROM categories\n` +
      `</cfquery>\n` +
      `<cfoutput>\n` +
      `<cfloop query="getCats">\n` +
      `    <h2>#getCats.name#</h2>\n` +
      `    <cfquery name="getItems" datasource="db">\n` +
      `        SELECT label FROM items\n` +
      `    </cfquery>\n` +
      `</cfloop>\n` +
      `</cfoutput>\n`;
    const result = convertCfmToHandler(src, baseOpts);
    const queryExecutes = result.handlerBody.match(/queryExecute/g) ?? [];
    assert.strictEqual(queryExecutes.length, 2);
  });

  it("builds a view model for a query nested in a display loop", () => {
    const src =
      `<cfquery name="getCats" datasource="db">\n` +
      `    SELECT id, name FROM categories\n` +
      `</cfquery>\n` +
      `<cfoutput>\n` +
      `<cfloop query="getCats">\n` +
      `    <h2>#getCats.name#</h2>\n` +
      `    <cfquery name="getItems" datasource="db">\n` +
      `        SELECT label FROM items\n` +
      `        WHERE cat = <cfqueryparam value="#getCats.id#" cfsqltype="cf_sql_integer">\n` +
      `    </cfquery>\n` +
      `    <cfloop query="getItems"><li>#getItems.label#</li></cfloop>\n` +
      `</cfloop>\n` +
      `</cfoutput>\n`;
    const result = convertCfmToHandler(src, baseOpts);
    // Handler reproduces the loop and keys the nested query by iteration.
    assert.match(result.handlerBody, /prc\.getItems = \{\};/);
    assert.match(result.handlerBody, /cfloop\( query="prc\.getCats" \)/);
    assert.match(
      result.handlerBody,
      /prc\.getItems\[ prc\.getCats\.currentRow \] = queryExecute/
    );
    // View keeps the display loop and re-localizes the query per iteration.
    assert.strictEqual(result.hasView, true);
    assert.match(result.viewBody, /<cfloop query="prc\.getCats">/);
    assert.match(
      result.viewBody,
      /<cfset getItems = prc\.getItems\[ prc\.getCats\.currentRow \]>/
    );
    assert.match(result.viewBody, /<cfloop query="getItems">/);
    assert.match(result.viewBody, /#getItems\.label#/);
  });

  it("splits a mixed cfif into guarded handler logic and view markup", () => {
    const src =
      `<cfif url.show>\n` +
      `    <cfquery name="getData" datasource="db">SELECT 1 AS n</cfquery>\n` +
      `    <p>#getData.n#</p>\n` +
      `</cfif>\n`;
    const result = convertCfmToHandler(src, baseOpts);
    assert.match(result.handlerBody, /if \(url\.show\) \{/);
    assert.match(result.handlerBody, /queryExecute/);
    assert.strictEqual(result.hasView, true);
    assert.match(result.viewBody, /<cfif url\.show>/);
    assert.match(result.viewBody, /<p>#prc\.getData\.n#<\/p>/);
  });

  it("qualifies a view cfif condition that reads a handler variable", () => {
    const src =
      `<cfset isAdmin = true>\n` +
      `<cfif isAdmin>\n` +
      `    <div>admin</div>\n` +
      `</cfif>\n`;
    const result = convertCfmToHandler(src, baseOpts);
    assert.strictEqual(result.hasView, true);
    assert.match(result.viewBody, /<cfif prc\.isAdmin>/);
  });
});
