import * as assert from "assert";
import { stripView } from "../src/transform/stripView";

describe("stripView", () => {
  it("drops plain HTML and text, keeps cf logic", () => {
    const src = [
      "<table>",
      "  <cfset total = 0>",
      "  <tr><td>Hello #name#</td></tr>",
      "</table>"
    ].join("\n");
    const { output } = stripView(src);
    assert.strictEqual(output, "  <cfset total = 0>\n");
  });

  it("keeps cf comments verbatim", () => {
    const src = "<div><!--- a note ---><cfset x = 1></div>";
    const { output } = stripView(src);
    assert.ok(output.includes("<!--- a note --->"));
    assert.ok(output.includes("<cfset x = 1>"));
    assert.ok(!output.includes("<div>"));
  });

  it("drops cf logic embedded inside an HTML tag", () => {
    const src = '<tr id="" <cfif foo>name=""</cfif>>row</tr>';
    const { output } = stripView(src);
    assert.strictEqual(output, "");
  });

  it("keeps cf logic that wraps HTML, stripping the HTML inside", () => {
    const src = [
      '<cfloop query="q">',
      "  <tr><td>#q.id#</td></tr>",
      "</cfloop>"
    ].join("\n");
    const { output } = stripView(src);
    // The stripped-out <tr>/<td> row leaves a single blank line marking where
    // markup was removed.
    assert.strictEqual(output, '<cfloop query="q">\n\n</cfloop>\n');
  });

  it("keeps cfscript blocks verbatim including embedded < and >", () => {
    const src = "<p>x</p><cfscript>\n  if (a < b) { c = 1; }\n</cfscript><p>y</p>";
    const { output } = stripView(src);
    assert.ok(output.includes("<cfscript>"));
    assert.ok(output.includes("if (a < b) { c = 1; }"));
    assert.ok(output.includes("</cfscript>"));
    assert.ok(!output.includes("<p>"));
  });

  it("does not let a quoted attribute > end an HTML tag early", () => {
    const src = '<a title="1 > 0" href="#"><cfset y = 2></a>';
    const { output } = stripView(src);
    assert.strictEqual(output, "<cfset y = 2>\n");
  });

  it("handles cfset whose value contains markup and >", () => {
    const src = '<cfset msg = "<b>hi</b>"><div>x</div>';
    const { output } = stripView(src);
    assert.strictEqual(output, '<cfset msg = "<b>hi</b>">\n');
  });

  it("reports counts", () => {
    const src = "<div><!--- c ---><cfset a=1><cfif a><br></cfif></div>";
    const r = stripView(src);
    assert.strictEqual(r.commentsKept, 1);
    // <cfset> and <cfif> are opening/void constructs; </cfif> is not counted.
    assert.strictEqual(r.cfConstructsKept, 2);
    assert.ok(r.htmlTagsStripped >= 3); // <div>, <br>, </div>
  });
});
