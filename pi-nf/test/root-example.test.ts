import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createNeedsForever } from "../src/needs-forever.js";

const example = fileURLToPath(new URL("../../examples/root-workspace", import.meta.url));

test("runnable root example checks both projects from their command cwd and fails until each requirement is met", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-nf-root-example-"));
  try {
    cpSync(example, root, { recursive: true });
    const config = JSON.parse(readFileSync(join(root, "needs-forever.json"), "utf8"));
    const needs = createNeedsForever({ cwd: root, home: join(root, ".pi-nf", "home"), issueReader: async () => null });
    const preview = await needs.preview({ repo: "example/root", issue: 7 });
    assert.deepEqual(preview.gaps, []);
    assert.equal(preview.source, "project");
    assert.equal(preview.contract?.workspace, root);
    assert.deepEqual(preview.contract?.verify, config.verify);
    const run = () => spawnSync(process.execPath, ["verify.mjs"], { cwd: root, encoding: "utf8", timeout: 10_000 });
    let result = run();
    assert.equal(result.status, 1);
    assert.match(result.stdout, /alpha: FAIL/);
    assert.match(result.stdout, /beta: FAIL/);
    writeFileSync(join(root, "projects/alpha/src/value.txt"), "alpha-ready\n");
    result = run();
    assert.equal(result.status, 1);
    assert.match(result.stdout, /alpha: PASS/);
    assert.match(result.stdout, /beta: FAIL/);
    writeFileSync(join(root, "projects/beta/src/value.txt"), "beta-ready\n");
    result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /alpha: PASS/);
    assert.match(result.stdout, /beta: PASS/);
    const observations = result.stdout.trim().split("\n").filter((line) => line.startsWith("{" )).map((line) => JSON.parse(line));
    assert.equal(observations[0].root, root);
    assert.deepEqual(observations.slice(1).map((value) => value.cwd), [join(root, "projects/alpha"), join(root, "projects/beta")]);
    // The other single-child failure must not be hidden by a successful beta check.
    writeFileSync(join(root, "projects/alpha/src/value.txt"), "alpha-pending\n");
    result = run();
    assert.equal(result.status, 1);
    assert.match(result.stdout, /alpha: FAIL/);
    assert.match(result.stdout, /beta: PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
