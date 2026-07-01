import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const index = path.join(process.cwd(), "dist", "index.html");
assert.equal(fs.existsSync(index), true);
assert.match(fs.readFileSync(index, "utf8"), /Kungfu web surface fixture/);

