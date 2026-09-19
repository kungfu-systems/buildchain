import assert from "node:assert/strict";
import fs from "node:fs";
assert.ok(fs.statSync("dist/paper.pdf").size > 0);
