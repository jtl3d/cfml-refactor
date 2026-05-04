import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import {
  analyzeViewCalls,
  annotateRepeatedCalls
} from "../src/analyzer/analyzeViewCalls";
import type {
  CallCategory,
  ClassifiedCall
} from "../src/analyzer/classifyCall";

const ROOT = path.join(__dirname, "fixtures", "phase6", "input");
const ROOT_ALT = path.join(
  __dirname,
  "..",
  "..",
  "test",
  "fixtures",
  "phase6",
  "input"
);

function fixturePath(name: string): string {
  const direct = path.join(ROOT, name);
  if (fs.existsSync(direct)) return direct;
  return path.join(ROOT_ALT, name);
}

function read(name: string): string {
  return fs.readFileSync(fixturePath(name), "utf8");
}

function run(name: string) {
  return analyzeViewCalls(read(name), `views/${name}`);
}

function find(
  classified: ClassifiedCall[],
  name: string
): ClassifiedCall | undefined {
  return classified.find((c) => c.call.name === name);
}

function categoryOf(
  classified: ClassifiedCall[],
  name: string
): CallCategory | undefined {
  return find(classified, name)?.category;
}

describe("phase6.classifyCall", () => {
  it("safe-formatting.cfm — only built-in formatting, no warnings", () => {
    const r = run("safe-formatting.cfm");
    assert.strictEqual(r.counts["service-call"], 0);
    assert.strictEqual(r.counts["handler-logic"], 0);
    assert.ok(r.counts["view-safe"] >= 5);
    for (const c of r.classified) {
      assert.strictEqual(c.category, "view-safe", `${c.call.name} not view-safe`);
    }
  });

  it("getInstance-call.cfm — getInstance flagged as service-call (highest priority)", () => {
    const r = run("getInstance-call.cfm");
    const gi = find(r.classified, "getInstance");
    assert.ok(gi, "expected getInstance call");
    assert.strictEqual(gi.category, "service-call");
    assert.match(gi.reason, /WireBox/i);
  });

  it("getInstance-call.cfm — chained service method also flagged", () => {
    const r = run("getInstance-call.cfm");
    const m = find(r.classified, "getActiveUsers");
    assert.ok(m);
    assert.strictEqual(m.category, "service-call");
    assert.strictEqual(m.call.receiver, "userService");
  });

  it("handler-logic-getter.cfm — getUser flagged as handler-logic", () => {
    const r = run("handler-logic-getter.cfm");
    const gu = find(r.classified, "getUser");
    assert.ok(gu);
    assert.strictEqual(gu.category, "handler-logic");
    assert.strictEqual(gu.call.assignedTo, "prc.user");
    assert.ok(gu.argSources.includes("url"));
    assert.match(gu.suggestion, /handler/i);
  });

  it("service-method-call.cfm — userService.findById flagged as service-call", () => {
    const r = run("service-method-call.cfm");
    const fb = find(r.classified, "findById");
    assert.ok(fb);
    assert.strictEqual(fb.category, "service-call");
    assert.strictEqual(fb.call.receiver, "userService");
  });

  it("loop-bound-call.cfm — call inside cfloop has loop-iterator argument source", () => {
    const r = run("loop-bound-call.cfm");
    const ld = find(r.classified, "loadUserDetail");
    assert.ok(ld);
    assert.strictEqual(ld.category, "handler-logic");
    assert.ok(ld.call.insideLoop, "should be flagged insideLoop");
    assert.ok(
      ld.argSources.includes("loop"),
      `expected 'loop' in argSources, got ${ld.argSources.join(",")}`
    );
    assert.match(ld.suggestion, /Phase 4/i);
  });

  it("repeated-call.cfm — same call 3x grouped as caching candidate", () => {
    const r = run("repeated-call.cfm");
    const repeats = annotateRepeatedCalls(r);
    const groups = [...repeats.values()].filter((g) => g.length > 1);
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].length, 3);
    assert.strictEqual(groups[0][0].call.name, "calculateTotal");
    assert.strictEqual(groups[0][0].category, "handler-logic");
  });

  it("url-arg-call.cfm — url.* args yield 'rc' suggestion phrasing", () => {
    const r = run("url-arg-call.cfm");
    const gr = find(r.classified, "loadReport");
    assert.ok(gr);
    assert.ok(gr.argSources.includes("url"));
    assert.match(gr.suggestion, /rc/i);
  });

  it("literal-arg-call.cfm — literal-only args yield 'literal' suggestion", () => {
    const r = run("literal-arg-call.cfm");
    const lb = find(r.classified, "loadBanner");
    assert.ok(lb);
    assert.deepStrictEqual(lb.argSources, ["literal"]);
    assert.match(lb.suggestion, /literal/i);
  });

  it("custom-display-fn.cfm — formatX/renderX classified as view-possible", () => {
    const r = run("custom-display-fn.cfm");
    assert.strictEqual(categoryOf(r.classified, "formatUserName"), "view-possible");
    assert.strictEqual(categoryOf(r.classified, "renderGreeting"), "view-possible");
    assert.strictEqual(r.counts["handler-logic"], 0);
    assert.strictEqual(r.counts["service-call"], 0);
  });

  it("entityLoad.cfm — entityLoad flagged as service-call", () => {
    const r = run("entityLoad.cfm");
    const el = find(r.classified, "entityLoad");
    assert.ok(el);
    assert.strictEqual(el.category, "service-call");
    assert.match(el.reason, /ORM/i);
  });

  it("createObject-call.cfm — createObject flagged as service-call", () => {
    const r = run("createObject-call.cfm");
    const co = find(r.classified, "createObject");
    assert.ok(co);
    assert.strictEqual(co.category, "service-call");
  });

  it("mixed.cfm — produces calls in all categories with correct counts", () => {
    const r = run("mixed.cfm");
    assert.ok(
      r.counts["service-call"] >= 2,
      `expected >=2 service-call, got ${r.counts["service-call"]}`
    );
    assert.ok(
      r.counts["handler-logic"] >= 1,
      `expected >=1 handler-logic, got ${r.counts["handler-logic"]}`
    );
    assert.ok(
      r.counts["view-safe"] >= 3,
      `expected >=3 view-safe, got ${r.counts["view-safe"]}`
    );
    assert.strictEqual(categoryOf(r.classified, "getInstance"), "service-call");
    assert.strictEqual(categoryOf(r.classified, "findRecent"), "service-call");
    assert.strictEqual(categoryOf(r.classified, "getUser"), "handler-logic");
  });

  it("nested-calls.cfm — inner getUser flagged, outer dateFormat is safe", () => {
    const r = run("nested-calls.cfm");
    assert.strictEqual(categoryOf(r.classified, "dateFormat"), "view-safe");
    assert.strictEqual(categoryOf(r.classified, "getUser"), "handler-logic");
  });

  it("calls-in-attributes.cfm — isAdmin in cfif and getMenuItems in cfloop are detected", () => {
    const r = run("calls-in-attributes.cfm");
    const isAdmin = find(r.classified, "isAdmin");
    assert.ok(isAdmin, "expected isAdmin call from <cfif>");
    assert.ok(isAdmin.call.insideConditional);
    const menu = find(r.classified, "getMenuItems");
    assert.ok(menu, "expected getMenuItems call from cfloop array=...");
    assert.strictEqual(menu.category, "handler-logic");
  });
});

describe("phase6.viewSafeFunctions config", () => {
  it("extra entries in viewSafeFunctions promote a custom name to view-safe", () => {
    const src = `<cfoutput>#myTeamHelper(prc.user)#</cfoutput>`;
    const baseline = analyzeViewCalls(src, "views/x.cfm");
    assert.strictEqual(
      baseline.classified[0].category,
      "view-possible",
      "without config, custom name defaults to view-possible"
    );
    const promoted = analyzeViewCalls(src, "views/x.cfm", {
      extraSafe: ["myTeamHelper"]
    });
    assert.strictEqual(promoted.classified[0].category, "view-safe");
  });

  it("custom handler prefixes are honored", () => {
    const src = `<cfset prc.x = derive(url.id)>`;
    const baseline = analyzeViewCalls(src, "views/x.cfm");
    assert.notStrictEqual(baseline.classified[0].category, "handler-logic");
    const customized = analyzeViewCalls(src, "views/x.cfm", {
      handlerPrefixes: ["derive"]
    });
    assert.strictEqual(customized.classified[0].category, "handler-logic");
  });

  it("custom service patterns are honored", () => {
    const src = `<cfset x = userRegistry.lookup(1)>`;
    const baseline = analyzeViewCalls(src, "views/x.cfm");
    const lookupCall = baseline.classified.find((c) => c.call.name === "lookup");
    assert.ok(lookupCall);
    // Without "Registry" in patterns, the receiver doesn't match.
    assert.notStrictEqual(lookupCall.category, "service-call");
    const customized = analyzeViewCalls(src, "views/x.cfm", {
      servicePatterns: ["Registry"]
    });
    const c2 = customized.classified.find((c) => c.call.name === "lookup");
    assert.ok(c2);
    assert.strictEqual(c2.category, "service-call");
  });
});
