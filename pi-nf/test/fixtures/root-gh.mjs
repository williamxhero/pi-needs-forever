// Controlled external gh fixture: never contacts GitHub or uses credentials.
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const directory = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const repo = args[args.indexOf("--repo") + 1];
assert.ok(args.includes("--repo"), "repository must be explicit");
assert.ok(["fixture/alpha", "fixture/beta"].includes(repo), "known repository");
assert.equal(args[0], "issue");
assert.equal(args[2], "7");
appendFileSync(join(directory, "gh-calls.jsonl"), JSON.stringify({ args, repo, cwd: process.cwd() }) + "\n");
const path = join(directory, repo.split("/")[1] + "-issue.json");
const issue = JSON.parse(readFileSync(path, "utf8"));
if (args[1] === "edit") {
  assert.ok(args.includes("--body-file"), "upload must use a file, not a pipeline/body argument");
  assert.ok(!args.includes("--body"));
  const bodyPath = args[args.indexOf("--body-file") + 1];
  const bytes = readFileSync(bodyPath);
  assert.notEqual(bytes.subarray(0, 3).toString("hex"), "efbbbf", "UTF-8 without BOM");
  issue.body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assert.ok(issue.body.includes("中文交付"));
  writeFileSync(path, JSON.stringify(issue));
  console.log("uploaded");
} else if (args[1] === "close") {
  issue.state = "CLOSED";
  writeFileSync(path, JSON.stringify(issue));
  console.log("closed");
} else {
  assert.equal(args[1], "view");
  console.log(JSON.stringify(issue));
}
