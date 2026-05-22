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
