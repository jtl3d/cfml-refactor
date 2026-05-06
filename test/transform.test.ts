import * as assert from "assert";
import { transformDocument } from "../src/transform/convertQuery";
import { loadFixture } from "./helpers";

const PAIRS: ReadonlyArray<readonly [string, "transform" | "unchanged"]> = [
  ["basic", "transform"],
  ["with-datasource", "transform"],
  ["named-params-from-vars", "transform"],
  ["literal-params-from-columns", "transform"],
  ["colliding-param-names", "transform"],
  ["list-param", "transform"],
  ["null-param", "transform"],
  ["already-scoped-name", "transform"],
  ["conditional-sql", "transform"],
  ["qoq", "unchanged"],
  ["skip-magic-comment", "unchanged"],
  ["missing-cfsqltype", "transform"],
  ["double-quotes-in-sql", "transform"],
  ["dedup-same-value", "transform"],
  ["query-name-references", "transform"],
  ["interpolated-literals", "transform"]
];

function diffString(expected: string, actual: string): string {
  const e = expected.split("\n");
  const a = actual.split("\n");
  const max = Math.max(e.length, a.length);
  const lines: string[] = [];
  for (let i = 0; i < max; i++) {
    const eL = e[i] ?? "<EOF>";
    const aL = a[i] ?? "<EOF>";
    if (eL !== aL) {
      lines.push(`L${i + 1}: expected ${JSON.stringify(eL)}`);
      lines.push(`L${i + 1}:   actual ${JSON.stringify(aL)}`);
    }
  }
  return lines.length ? lines.join("\n") : "(no line-level diff)";
}

describe("transform: phase 2 fixtures", () => {
  for (const [name, kind] of PAIRS) {
    it(`${kind === "transform" ? "converts" : "leaves alone"} ${name}.cfm`, () => {
      const input = loadFixture(`phase2/input/${name}.cfm`);
      const expected = loadFixture(`phase2/expected/${name}.cfm`);
      const result = transformDocument(input);
      if (result.output !== expected) {
        const msg = diffString(expected, result.output);
        assert.fail(`output mismatch for ${name}.cfm:\n${msg}\n\n--- expected ---\n${expected}\n--- actual ---\n${result.output}`);
      }
      if (kind === "unchanged") {
        assert.strictEqual(result.transformations.length, 0);
        assert.ok(
          result.skipped.length > 0,
          "unchanged fixtures should produce a skip log entry"
        );
      } else {
        assert.strictEqual(result.transformations.length, 1);
      }
    });
  }

  it("is idempotent: re-running the transform is a no-op", () => {
    const input = loadFixture("phase2/input/basic.cfm");
    const once = transformDocument(input).output;
    const twice = transformDocument(once).output;
    assert.strictEqual(twice, once);
  });

  it("logs skipped queries with a reason (cfloop inside cfquery)", () => {
    const src =
      `<cfquery name="x" datasource="db">\n` +
      `    SELECT * FROM things WHERE id IN (\n` +
      `    <cfloop list="1,2,3" index="i">#i#,</cfloop>\n` +
      `    0)\n` +
      `</cfquery>\n`;
    const result = transformDocument(src);
    assert.strictEqual(result.transformations.length, 0);
    assert.strictEqual(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /<cfloop>/);
  });

  it("skips a cfqueryparam value containing a function call", () => {
    const src =
      `<cfquery name="x" datasource="db">\n` +
      `    SELECT 1 WHERE id = <cfqueryparam value="#someFunc(x)#" cfsqltype="cf_sql_integer">\n` +
      `</cfquery>\n`;
    const result = transformDocument(src);
    assert.strictEqual(result.transformations.length, 0);
    assert.strictEqual(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /complex expression/);
  });

  it("skips queries with unknown <cfquery> attributes", () => {
    const src =
      `<cfquery name="x" datasource="db" debug="true">\n` +
      `    SELECT 1\n` +
      `</cfquery>\n`;
    const result = transformDocument(src);
    assert.strictEqual(result.transformations.length, 0);
    assert.strictEqual(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /unknown <cfquery> attribute/);
  });
});
