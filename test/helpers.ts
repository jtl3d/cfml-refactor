import * as fs from "fs";
import * as path from "path";

const FIXTURE_DIRS = [
  path.join(__dirname, "fixtures"),
  path.join(__dirname, "..", "..", "test", "fixtures")
];

export function loadFixture(name: string): string {
  for (const dir of FIXTURE_DIRS) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, "utf8");
    }
  }
  throw new Error(`Fixture not found: ${name}`);
}
