import * as assert from "assert";
import { parse } from "../src/parser/parse";
import type { TagNode } from "../src/parser/ast";
import { loadFixture } from "./helpers";

describe("parser", () => {
  it("parses a top-level cfquery", () => {
    const src = loadFixture("plain-query.cfm");
    const doc = parse(src);
    const tags = doc.children.filter(
      (n): n is TagNode => n.type === "tag"
    );
    const query = tags.find((t) => t.name === "cfquery");
    assert.ok(query, "expected to find a cfquery node");
    assert.strictEqual(query.attributes.get("name")?.value, "getUsers");
    assert.strictEqual(query.attributes.get("datasource")?.value, "appdb");
    assert.strictEqual(query.selfClosing, false);
    const params = query.children.filter(
      (n) => n.type === "tag" && n.name === "cfqueryparam"
    );
    assert.strictEqual(params.length, 2);
  });

  it("parses cfquery inside cfloop", () => {
    const src = loadFixture("query-in-query-loop.cfm");
    const doc = parse(src);
    const top = doc.children.filter(
      (n): n is TagNode => n.type === "tag"
    );
    const loop = top.find((t) => t.name === "cfloop");
    assert.ok(loop);
    assert.strictEqual(loop.attributes.get("query")?.value, "getUsers");
    const inner = loop.children.find(
      (n): n is TagNode => n.type === "tag" && n.name === "cfquery"
    );
    assert.ok(inner, "cfquery should be a child of cfloop");
  });

  it("parses cfquery with conditional SQL", () => {
    const src = loadFixture("query-with-conditional.cfm");
    const doc = parse(src);
    const query = doc.children.find(
      (n): n is TagNode => n.type === "tag" && n.name === "cfquery"
    );
    assert.ok(query);
    const cfif = query.children.find(
      (n): n is TagNode => n.type === "tag" && n.name === "cfif"
    );
    assert.ok(cfif, "cfif should appear inside cfquery body");
  });

  it("treats cfscript as opaque script node", () => {
    const src = loadFixture("query-in-script.cfm");
    const doc = parse(src);
    const script = doc.children.find((n) => n.type === "script");
    assert.ok(script, "expected a script node");
    if (script && script.type === "script") {
      assert.ok(
        script.body.includes("setSQL"),
        "script body should retain its raw text"
      );
      assert.ok(
        !doc.children.some(
          (n) => n.type === "tag" && (n as TagNode).name === "cfquery"
        ),
        "no cfquery should be parsed inside cfscript"
      );
    }
  });

  it("parses comments", () => {
    const src = loadFixture("magic-skip.cfm");
    const doc = parse(src);
    const comments = doc.children.filter((n) => n.type === "comment");
    assert.strictEqual(comments.length, 1);
    assert.ok(comments[0].type === "comment");
    if (comments[0].type === "comment") {
      assert.match(comments[0].text, /@cfml-refactor:skip/);
    }
  });

  it("parses attributes with #interpolation# and detects it", () => {
    const src = `<cfquery name="x" datasource="db">
      WHERE id = <cfqueryparam value="#url.id#">
    </cfquery>`;
    const doc = parse(src);
    const query = doc.children.find(
      (n): n is TagNode => n.type === "tag" && n.name === "cfquery"
    );
    assert.ok(query);
    const param = query.children.find(
      (n): n is TagNode => n.type === "tag" && n.name === "cfqueryparam"
    );
    assert.ok(param);
    assert.strictEqual(param.attributes.get("value")?.hasInterpolation, true);
  });

  it("handles single-quoted attribute values", () => {
    const src = `<cfquery name='x' datasource='db'>SELECT 1</cfquery>`;
    const doc = parse(src);
    const query = doc.children.find(
      (n): n is TagNode => n.type === "tag" && n.name === "cfquery"
    );
    assert.ok(query);
    assert.strictEqual(query.attributes.get("name")?.value, "x");
  });

  it("preserves HTML and text as content", () => {
    const src = loadFixture("mixed.cfm");
    const doc = parse(src);
    const contents = doc.children.filter((n) => n.type === "content");
    const concatenated = contents.map((c) => c.type === "content" ? c.text : "").join("");
    assert.ok(concatenated.includes("<!DOCTYPE html>"));
    assert.ok(concatenated.includes("<h1>User list</h1>"));
  });
});
