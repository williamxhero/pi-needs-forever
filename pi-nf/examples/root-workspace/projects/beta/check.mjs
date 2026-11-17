import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
console.log(JSON.stringify({ project: "beta", cwd: process.cwd() }));
assert.equal(readFileSync("src/value.txt", "utf8").trim(), "beta-ready");
