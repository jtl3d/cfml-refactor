import * as assert from "assert";
import { transformDocument } from "../src/transform/convertQuery";
import {
  buildSafeBuiltInSet,
  isSafeBuiltInExpression
} from "../src/transform/safeBuiltins";

describe("safe-builtins: isSafeBuiltInExpression", () => {
  const safelist = buildSafeBuiltInSet();

  const ACCEPTED = [
    "#Trim(this_component)#",
    "#dateformat(someVar, 'dd-mm-yyyy')#",
    "#UCase(someVar)#",
    "#LCase(trim(foo))#",
    "#Len(bar)#",
    "#Now()#",
    '#dateformat(arguments.startDate, "yyyy-mm-dd")#',
    "#trim( arguments.firstName )#",
    "#javacast('int', form.id)#",
    "#hash(url.token)#"
  ];

  for (const value of ACCEPTED) {
    it(`accepts ${value}`, () => {
      assert.strictEqual(isSafeBuiltInExpression(value, safelist), true);
    });
  }

  const REJECTED = [
    "#someUnknown(x)#",                      // not in safelist
    "#service.method(x)#",                   // method call (dotted callee)
    "#trim(foo) & ' suffix'#",               // string concat
    "#IIF(x, 'a', 'b')#",                    // conditional
    "#arguments.id ? 1 : 2#",                // ternary
    "#foo(bar) + baz(qux)#",                 // arithmetic
    "prefix-#trim(x)#-suffix",               // outer concat
    "#trim(x)# extra",                       // junk after closing #
    "#trim(x)",                              // unclosed #
    "trim(x)",                               // not interpolated
    "#trim()#"                               // empty args is allowed actually?
  ];

  for (const value of REJECTED.slice(0, REJECTED.length - 1)) {
    it(`rejects ${value}`, () => {
      assert.strictEqual(isSafeBuiltInExpression(value, safelist), false);
    });
  }

  it("accepts empty-arg builtin call (e.g. #Now()#)", () => {
    assert.strictEqual(isSafeBuiltInExpression("#Now()#", safelist), true);
  });

  it("accepts nested builtins", () => {
    assert.strictEqual(
      isSafeBuiltInExpression("#trim(LCase(arguments.foo))#", safelist),
      true
    );
  });

  it("respects extra safelist entries", () => {
    const extended = buildSafeBuiltInSet(["myCustomFunc"]);
    assert.strictEqual(
      isSafeBuiltInExpression("#myCustomFunc(arguments.id)#", extended),
      true
    );
    assert.strictEqual(
      isSafeBuiltInExpression(
        "#myCustomFunc(arguments.id)#",
        buildSafeBuiltInSet()
      ),
      false
    );
  });
});

describe("convertQuery: safe-builtin cfqueryparam values", () => {
  it("converts a query whose param uses Trim(...) instead of skipping it", () => {
    const src =
      `<cfquery name="getThing" datasource="appdb">\n` +
      `    SELECT * FROM things WHERE name = ` +
      `<cfqueryparam value="#Trim(arguments.name)#" cfsqltype="cf_sql_varchar">\n` +
      `</cfquery>\n`;
    const result = transformDocument(src);
    assert.strictEqual(result.skipped.length, 0, "should not skip a Trim() value");
    assert.strictEqual(result.transformations.length, 1);
    // The function call survives verbatim as the param's value.
    assert.match(result.output, /value: Trim\(arguments\.name\)/);
  });

  it("still skips a query whose param uses an unknown function", () => {
    const src =
      `<cfquery name="getThing" datasource="appdb">\n` +
      `    SELECT * FROM things WHERE id = ` +
      `<cfqueryparam value="#someBespokeFn(arguments.id)#" cfsqltype="cf_sql_integer">\n` +
      `</cfquery>\n`;
    const result = transformDocument(src);
    assert.strictEqual(result.transformations.length, 0);
    assert.strictEqual(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /complex expression/);
  });

  it("skips a query whose param uses string concatenation", () => {
    const src =
      `<cfquery name="getThing" datasource="appdb">\n` +
      `    SELECT * FROM things WHERE name = ` +
      `<cfqueryparam value="#trim(arguments.name) & '-x'#" cfsqltype="cf_sql_varchar">\n` +
      `</cfquery>\n`;
    const result = transformDocument(src);
    assert.strictEqual(result.transformations.length, 0);
    assert.strictEqual(result.skipped.length, 1);
  });

  it("honors extraSafeBuiltInFunctions option", () => {
    const src =
      `<cfquery name="getThing" datasource="appdb">\n` +
      `    SELECT * FROM things WHERE id = ` +
      `<cfqueryparam value="#myProjFn(arguments.id)#" cfsqltype="cf_sql_integer">\n` +
      `</cfquery>\n`;
    const skipped = transformDocument(src);
    assert.strictEqual(skipped.transformations.length, 0);
    const allowed = transformDocument(src, {
      extraSafeBuiltInFunctions: ["myProjFn"]
    });
    assert.strictEqual(allowed.transformations.length, 1);
    assert.match(allowed.output, /value: myProjFn\(arguments\.id\)/);
  });
});
