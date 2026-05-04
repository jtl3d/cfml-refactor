import * as assert from "assert";
import { hoistDocument } from "../src/transform/hoistQueries";
import { loadFixture } from "./helpers";

const FIXTURES = [
  "simple-hoist",
  "multiple-independent",
  "with-dependencies",
  "conditional-hoist",
  "conditional-with-rendering",
  "in-loop-skip",
  "loop-dependency-skip",
  "nested-conditional-skip",
  "in-trycatch-skip",
  "no-hoist-magic-comment",
  "existing-top-script",
  "idempotency",
  "mixed-hoistable-and-not"
] as const;

const TODAY = "2026-05-04";

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

describe("hoist: phase 3 fixtures", () => {
  for (const name of FIXTURES) {
    it(`hoists ${name}.cfm to its expected output`, () => {
      const input = loadFixture(`phase3/input/${name}.cfm`);
      const expected = loadFixture(`phase3/expected/${name}.cfm`);
      const result = hoistDocument(input, { today: TODAY });
      if (result.output !== expected) {
        const msg = diffString(expected, result.output);
        assert.fail(
          `output mismatch for ${name}.cfm:\n${msg}\n\n` +
            `--- expected ---\n${expected}\n` +
            `--- actual ---\n${result.output}`
        );
      }
    });
  }

  it("aborts cleanly when <cfquery> tags still exist", () => {
    const src =
      `<cfquery name="x" datasource="db">SELECT 1</cfquery>\n` +
      `<cfscript>\n  prc.y = queryExecute("SELECT 1", {}, {});\n</cfscript>\n`;
    const result = hoistDocument(src, { today: TODAY });
    assert.ok(result.error, "expected an error");
    assert.match(result.error!, /Phase 2/);
    assert.strictEqual(result.output, src);
  });

  it("aborts on dependency cycles without modifying the source", () => {
    const input = loadFixture("phase3/input/cycle-detection.cfm");
    const result = hoistDocument(input, { today: TODAY });
    assert.ok(result.error, "expected an error");
    assert.match(result.error!, /cycle/i);
    assert.strictEqual(result.output, input);
  });

  it("is idempotent: running hoist twice equals running once", () => {
    const input = loadFixture("phase3/input/with-dependencies.cfm");
    const once = hoistDocument(input, { today: TODAY }).output;
    const twice = hoistDocument(once, { today: TODAY }).output;
    assert.strictEqual(twice, once);
  });

  it("re-hoist of an already-hoisted file is a no-op", () => {
    const input = loadFixture("phase3/input/idempotency.cfm");
    const result = hoistDocument(input, { today: TODAY });
    assert.strictEqual(result.output, input);
    assert.ok(result.noChange);
  });

  it("logs hoisted, conditionally-hoisted, and skipped queries", () => {
    const input = loadFixture("phase3/input/mixed-hoistable-and-not.cfm");
    const result = hoistDocument(input, { today: TODAY });
    assert.strictEqual(result.hoisted.length, 1);
    assert.strictEqual(result.conditionallyHoisted.length, 1);
    const reportable = result.skipped.filter((s) => !s.noHoistMarker);
    assert.strictEqual(reportable.length, 2);
    assert.deepStrictEqual(
      reportable.map((s) => s.prcVar).sort(),
      ["errorLog", "userOrders"]
    );
  });

  it("skips no-hoist-marked queries silently (not in reportable list)", () => {
    const input = loadFixture("phase3/input/no-hoist-magic-comment.cfm");
    const result = hoistDocument(input, { today: TODAY });
    const reportable = result.skipped.filter((s) => !s.noHoistMarker);
    assert.strictEqual(reportable.length, 0);
    assert.strictEqual(result.skipped.length, 1);
    assert.ok(result.noChange);
  });
});
