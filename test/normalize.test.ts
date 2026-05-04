import * as assert from "assert";
import { normalizeQuery } from "../src/index/normalize";

describe("index.normalize", () => {
  it("produces same fingerprint for identical SQL with different whitespace", () => {
    const a = normalizeQuery("SELECT id, name\nFROM users\nWHERE dept_id = 5");
    const b = normalizeQuery("SELECT  id,  name FROM users WHERE  dept_id = 5");
    assert.strictEqual(a.fingerprint, b.fingerprint);
  });

  it("produces same fingerprint regardless of literal values", () => {
    const a = normalizeQuery("SELECT id FROM users WHERE id = 5");
    const b = normalizeQuery("SELECT id FROM users WHERE id = 99");
    assert.strictEqual(a.fingerprint, b.fingerprint);
  });

  it("treats :name, ?, and <cfqueryparam> as the same placeholder", () => {
    const a = normalizeQuery(
      "SELECT id FROM users WHERE id = <cfqueryparam value=\"#x#\" cfsqltype=\"cf_sql_integer\">"
    );
    const b = normalizeQuery("SELECT id FROM users WHERE id = :myParam");
    const c = normalizeQuery("SELECT id FROM users WHERE id = ?");
    assert.strictEqual(a.fingerprint, b.fingerprint);
    assert.strictEqual(b.fingerprint, c.fingerprint);
  });

  it("lowercases keywords but preserves identifier case by default", () => {
    const r = normalizeQuery("SELECT User_ID FROM Users WHERE Status = 'active'");
    assert.match(r.normalizedSQL, /select User_ID from Users where Status/);
  });

  it("normalizes identifier case when configured", () => {
    const r = normalizeQuery(
      "SELECT User_ID FROM Users WHERE Status = 'active'",
      { normalizeIdentifierCase: true, stripTableAliases: false }
    );
    assert.ok(r.normalizedSQL.includes("user_id"));
    assert.ok(r.normalizedSQL.includes("status"));
  });

  it("extracts tables from FROM and JOIN", () => {
    const r = normalizeQuery(
      "SELECT u.id FROM users u INNER JOIN depts d ON u.dept_id = d.id WHERE u.id = 1"
    );
    assert.deepStrictEqual(r.tables, ["depts", "users"]);
  });

  it("extracts SELECT columns and strips aliases", () => {
    const r = normalizeQuery(
      "SELECT id, u.name AS userName, COUNT(*) AS total FROM users u"
    );
    assert.deepStrictEqual(r.columns, ["id", "name", "count_*"]);
  });

  it("extracts WHERE columns", () => {
    const r = normalizeQuery(
      "SELECT id FROM users WHERE dept_id = 5 AND status = 'active' AND created_at > '2024-01-01'"
    );
    assert.deepStrictEqual(r.whereColumns, ["created_at", "dept_id", "status"]);
  });

  it("strips trailing semicolons and SQL comments", () => {
    const a = normalizeQuery("SELECT id FROM users; -- trailing comment\n");
    const b = normalizeQuery("SELECT id FROM users;");
    assert.strictEqual(a.fingerprint, b.fingerprint);
  });

  it("strips block comments", () => {
    const a = normalizeQuery("SELECT id /* inline note */ FROM users");
    const b = normalizeQuery("SELECT id FROM users");
    assert.strictEqual(a.fingerprint, b.fingerprint);
  });

  it("strips CFML comments", () => {
    const a = normalizeQuery(
      "SELECT id <!--- skip this ---> FROM users WHERE id = 1"
    );
    const b = normalizeQuery("SELECT id FROM users WHERE id = 1");
    assert.strictEqual(a.fingerprint, b.fingerprint);
  });

  it("differs in fingerprint when ORDER BY differs but stays structurally similar", () => {
    const a = normalizeQuery(
      "SELECT permission_id, name FROM permissions WHERE user_id = ?"
    );
    const b = normalizeQuery(
      "SELECT permission_id, name FROM permissions WHERE user_id = ? ORDER BY name"
    );
    assert.notStrictEqual(a.fingerprint, b.fingerprint);
    assert.deepStrictEqual(a.tables, b.tables);
    assert.deepStrictEqual(a.columns, b.columns);
    assert.deepStrictEqual(a.whereColumns, b.whereColumns);
  });

  it("strips single-letter aliases when configured", () => {
    const r = normalizeQuery(
      "SELECT u.id FROM users u WHERE u.dept_id = 5",
      { normalizeIdentifierCase: false, stripTableAliases: true }
    );
    assert.match(r.normalizedSQL, /from users where/);
  });
});
