import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { TaskContract, VerifyConfig } from "../src/types.js";
import { recordProtectedBaseline, runCompletionGate, workspaceDigest } from "../src/verify.js";

function contract(workspace: string, verify: VerifyConfig): TaskContract {
  return {
    schema_version: 1,
    task_id: "verify-task",
    workspace,
    goal: "verify",
    acceptance: [{ id: "A1", text: "verification" }],
    authorization: "local",
    c2: { mode: "legacy" },
    limits: { max_worker_turns: null, max_minutes: null },
    verify,
  };
}

function env(workspace: string): NodeExecutionEnv {
  return new NodeExecutionEnv({ cwd: workspace });
}

test("CompletionGate passes a fixed argv command without shell interpolation", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-gate-pass-"));
  try {
    const protectedPath = join(workspace, "verify.mjs");
    writeFileSync(protectedPath, "console.log('protected');\n");
    const task = contract(workspace, {
      argv: [process.execPath, "-e", "console.log('ok'); process.exit(0)"],
      timeout_seconds: 5,
      protected_files: ["verify.mjs"],
    });
    const baseline = recordProtectedBaseline(task);
    assert.ok(baseline);
    const result = await runCompletionGate({
      task,
      baseline,
      state_path: join(workspace, "state.sqlite"),
      env: env(workspace),
      context: BACKGROUND_CONTEXT,
    });
    assert.equal(result.configured, true);
    assert.equal(result.exit_code, 0);
    assert.equal(result.passed, true);
    assert.match(result.stdout, /ok/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("CompletionGate fails a nonzero verifier and records output", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-gate-fail-"));
  try {
    const task = contract(workspace, {
      argv: [process.execPath, "-e", "console.error('nope'); process.exit(7)"],
      timeout_seconds: 5,
      protected_files: [],
    });
    const result = await runCompletionGate({
      task,
      baseline: recordProtectedBaseline(task) ?? [],
      state_path: join(workspace, "state.sqlite"),
      env: env(workspace),
      context: BACKGROUND_CONTEXT,
    });
    assert.equal(result.passed, false);
    assert.equal(result.exit_code, 7);
    assert.match(result.stderr, /nope/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("CompletionGate blocks a changed protected file before running the verifier", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-gate-protected-"));
  try {
    const protectedPath = join(workspace, "verify.mjs");
    writeFileSync(protectedPath, "original\n");
    const task = contract(workspace, {
      argv: [process.execPath, "-e", "process.exit(0)"],
      timeout_seconds: 5,
      protected_files: ["verify.mjs"],
    });
    const baseline = recordProtectedBaseline(task);
    assert.ok(baseline);
    writeFileSync(protectedPath, "changed\n");
    const result = await runCompletionGate({
      task,
      baseline,
      state_path: join(workspace, "state.sqlite"),
      env: env(workspace),
      context: BACKGROUND_CONTEXT,
    });
    assert.equal(result.passed, false);
    assert.equal(result.protected_before.length, 1);
    assert.equal(result.exit_code, null);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("CompletionGate fails when the workspace changes during verification", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-gate-workspace-"));
  try {
    const task = contract(workspace, {
      argv: [process.execPath, "-e", "require('node:fs').writeFileSync('side-effect.txt','x')"],
      timeout_seconds: 5,
      protected_files: [],
    });
    const result = await runCompletionGate({
      task,
      baseline: recordProtectedBaseline(task) ?? [],
      state_path: join(workspace, "state.sqlite"),
      env: env(workspace),
      context: BACKGROUND_CONTEXT,
    });
    assert.equal(result.passed, false);
    assert.equal(result.workspace_changed, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("CompletionGate reports a timeout as failure", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-gate-timeout-"));
  try {
    const task = contract(workspace, {
      argv: [process.execPath, "-e", "setTimeout(()=>{}, 5000)"],
      timeout_seconds: 0.05,
      protected_files: [],
    });
    const result = await runCompletionGate({
      task,
      baseline: recordProtectedBaseline(task) ?? [],
      state_path: join(workspace, "state.sqlite"),
      env: env(workspace),
      context: BACKGROUND_CONTEXT,
    });
    assert.equal(result.passed, false);
    assert.equal(result.timed_out, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("CompletionGate rejects a configured verifier without a baseline", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-gate-missing-"));
  try {
    const task = contract(workspace, {
      argv: [process.execPath, "-e", "process.exit(0)"],
      timeout_seconds: 5,
      protected_files: ["verify.mjs"],
    });
    const result = await runCompletionGate({
      task,
      baseline: [],
      state_path: null,
      env: env(workspace),
      context: BACKGROUND_CONTEXT,
    });
    assert.equal(result.passed, false);
    assert.match(result.stderr, /baseline/i);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("workspaceDigest ignores the state database and test caches", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-gate-digest-"));
  try {
    const state = join(workspace, "state.sqlite");
    writeFileSync(state, "before");
    mkdirSync(join(workspace, ".pytest_cache"));
    writeFileSync(join(workspace, ".pytest_cache", "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n");
    writeFileSync(join(workspace, ".pytest_cache", "cache"), "before");
    const before = await workspaceDigest(workspace, state);
    writeFileSync(state, "after");
    writeFileSync(`${state}-wal`, "wal");
    writeFileSync(join(workspace, ".pytest_cache", "cache"), "after");
    assert.equal(await workspaceDigest(workspace, state), before);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
