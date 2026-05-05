import * as assert from "assert";
import { transformDocument } from "../src/transform/convertQuery";
import { loadFixture } from "./helpers";

const COND_FIXTURES: ReadonlyArray<{
  name: string;
  kind: "transform" | "skip";
  style?: "ternary" | "variable-based";
}> = [
  { name: "ternary-eligible-orderby", kind: "transform", style: "ternary" },
  { name: "ternary-eligible-simple", kind: "transform", style: "ternary" },
  { name: "style-b-single-conditional", kind: "transform", style: "variable-based" },
  { name: "style-b-multiple-conditionals", kind: "transform", style: "variable-based" },
  { name: "style-b-with-elseif", kind: "transform", style: "variable-based" },
  { name: "conditional-with-leading-text", kind: "transform", style: "variable-based" },
  { name: "conditional-with-trailing-text", kind: "transform", style: "variable-based" },
  { name: "conditional-wrapped-by-text", kind: "transform", style: "variable-based" },
  { name: "bare-cfif-no-else", kind: "transform", style: "variable-based" },
  { name: "param-in-cfif-and-cfelse-same-name", kind: "transform", style: "variable-based" },
  { name: "style-b-where-1-equals-1", kind: "transform", style: "variable-based" },
  { name: "nested-cfif-skip", kind: "skip" },
  { name: "cfloop-in-query-skip", kind: "skip" },
  { name: "cfset-in-query-skip", kind: "skip" }
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

describe("transform: phase 2.5 conditional SQL", () => {
  for (const fx of COND_FIXTURES) {
    it(`${fx.kind === "transform" ? "converts" : "skips"} ${fx.name}.cfm`, () => {
      const input = loadFixture(`phase2-5/conditional-sql/input/${fx.name}.cfm`);
      const expected = loadFixture(`phase2-5/conditional-sql/expected/${fx.name}.cfm`);
      const result = transformDocument(input);
      if (result.output !== expected) {
        const msg = diffString(expected, result.output);
        assert.fail(
          `output mismatch for ${fx.name}.cfm:\n${msg}\n\n--- expected ---\n${expected}\n--- actual ---\n${result.output}`
        );
      }
      if (fx.kind === "transform") {
        assert.strictEqual(result.transformations.length, 1);
        if (fx.style) {
          assert.strictEqual(result.transformations[0].style, fx.style);
        }
        assert.ok(result.transformations[0].styleReason, "expected a styleReason");
      } else {
        assert.strictEqual(result.transformations.length, 0);
        assert.strictEqual(result.skipped.length, 1);
      }
    });
  }

  it("idempotency: re-running on Style B output is a no-op", () => {
    const input = loadFixture("phase2-5/conditional-sql/input/style-b-multiple-conditionals.cfm");
    const once = transformDocument(input).output;
    const twice = transformDocument(once).output;
    assert.strictEqual(twice, once);
  });

  it("idempotency: re-running on Style A output is a no-op", () => {
    const input = loadFixture("phase2-5/conditional-sql/input/ternary-eligible-orderby.cfm");
    const once = transformDocument(input).output;
    const twice = transformDocument(once).output;
    assert.strictEqual(twice, once);
  });

  it("logs Style B reason mentioning <cfqueryparam>", () => {
    const input = loadFixture("phase2-5/conditional-sql/input/style-b-single-conditional.cfm");
    const result = transformDocument(input);
    assert.strictEqual(result.transformations.length, 1);
    assert.match(result.transformations[0].styleReason ?? "", /cfqueryparam/);
  });

  it("logs Style A reason mentioning text-only", () => {
    const input = loadFixture("phase2-5/conditional-sql/input/ternary-eligible-orderby.cfm");
    const result = transformDocument(input);
    assert.strictEqual(result.transformations.length, 1);
    assert.match(result.transformations[0].styleReason ?? "", /text-only/);
  });
});

const DS_FIXTURES: ReadonlyArray<{
  name: string;
  patterns: string[];
}> = [
  { name: "empty-config-datasource-present", patterns: [] },
  { name: "match-application-dsn", patterns: ["#application.dsn#"] },
  { name: "match-literal-name", patterns: ["myAppMain"] },
  { name: "no-match-still-emits", patterns: ["#application.dsn#", "myAppMain"] },
  { name: "match-with-params", patterns: ["#application.dsn#"] },
  { name: "match-with-other-options", patterns: ["myDsn"] },
  { name: "no-datasource-empty-config", patterns: [] },
  { name: "no-datasource-other-options", patterns: [] }
];

describe("transform: phase 2.5 datasource exclusion", () => {
  for (const fx of DS_FIXTURES) {
    it(`applies patterns ${JSON.stringify(fx.patterns)} for ${fx.name}.cfm`, () => {
      const input = loadFixture(`phase2-5/datasource-config/input/${fx.name}.cfm`);
      const expected = loadFixture(`phase2-5/datasource-config/expected/${fx.name}.cfm`);
      const result = transformDocument(input, {
        defaultDatasourcePatterns: fx.patterns
      });
      if (result.output !== expected) {
        const msg = diffString(expected, result.output);
        assert.fail(
          `output mismatch for ${fx.name}.cfm:\n${msg}\n\n--- expected ---\n${expected}\n--- actual ---\n${result.output}`
        );
      }
      assert.strictEqual(result.transformations.length, 1);
    });
  }

  it("multi-query file: pattern matches one but not another", () => {
    const src =
      `<cfquery name="a" datasource="#application.dsn#">SELECT 1</cfquery>\n` +
      `<cfquery name="b" datasource="reporting">SELECT 2</cfquery>\n` +
      `<cfquery name="c" datasource="myAppMain">SELECT 3</cfquery>\n`;
    const result = transformDocument(src, {
      defaultDatasourcePatterns: ["#application.dsn#", "myAppMain"]
    });
    assert.strictEqual(result.transformations.length, 3);
    // a and c should produce 1-arg queryExecute; b should keep datasource.
    assert.ok(/prc\.a = queryExecute\(\s*"\s*SELECT 1\s*"\s*\)/.test(result.output));
    assert.ok(/prc\.b = queryExecute\([\s\S]*datasource: "reporting"/.test(result.output));
    assert.ok(/prc\.c = queryExecute\(\s*"\s*SELECT 3\s*"\s*\)/.test(result.output));
  });
});
