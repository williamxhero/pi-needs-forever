import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractPolicy, contractHash, normalizeContract } from "../src/contract.js";
import { ContractError } from "../src/types.js";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "pi-nf-contract-"));
}

function valid(workspacePath: string): Record<string, unknown> {
  return {
    schema_version: 1,
    task_id: "task-1",
    workspace: workspacePath,
    goal: "Implement the feature",
    acceptance: [{ id: "A1", text: "Tests pass" }],
    authorization: "Only edit this workspace",
    limits: { max_worker_turns: null, max_minutes: null },
  };
}

test("contract normalizes workspace and defaults C2 to legacy", () => {
  const dir = workspace();
  try {
    const prepared = new ContractPolicy().prepare(valid(dir));
    assert.equal(prepared.task.workspace, dir);
    assert.deepEqual(prepared.task.c2, { mode: "legacy" });
    assert.equal(prepared.task.acceptance[0]?.id, "A1");
    assert.match(prepared.contract_sha256, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract hash is stable across repeated preparation", () => {
  const dir = workspace();
  try {
    const first = new ContractPolicy().prepare(valid(dir));
    const second = new ContractPolicy().prepare(valid(dir));
    assert.equal(first.contract_sha256, second.contract_sha256);
    assert.equal(contractHash(normalizeContract(valid(dir))), first.contract_sha256);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract rejects relative and missing workspaces", () => {
  assert.throws(() => new ContractPolicy().prepare(valid("relative/path")), ContractError);
  assert.throws(() => new ContractPolicy().prepare(valid(join(tmpdir(), "pi-nf-does-not-exist"))), ContractError);
  const dir = workspace();
  try {
    writeFileSync(join(dir, "file.txt"), "x");
    assert.throws(() => new ContractPolicy().prepare(valid(join(dir, "file.txt"))), ContractError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract rejects empty goal, acceptance, authorization and duplicate ids", () => {
  const dir = workspace();
  try {
    for (const mutate of [
      (c: Record<string, unknown>) => { c.goal = " "; },
      (c: Record<string, unknown>) => { c.acceptance = []; },
      (c: Record<string, unknown>) => { c.authorization = ""; },
      (c: Record<string, unknown>) => { c.acceptance = [{ id: "A1", text: "one" }, { id: "A1", text: "two" }]; },
    ]) {
      const contract = valid(dir);
      mutate(contract);
      assert.throws(() => new ContractPolicy().prepare(contract), ContractError);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract rejects invalid limits", () => {
  const dir = workspace();
  try {
    const contract = valid(dir);
    (contract.limits as Record<string, unknown>).max_worker_turns = 0;
    assert.throws(() => new ContractPolicy().prepare(contract), ContractError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract accepts a valid verifier configuration and rejects invalid shapes", () => {
  const dir = workspace();
  try {
    const contract = valid(dir);
    contract.verify = { argv: [process.execPath, "verify.mjs"], timeout_seconds: 10, protected_files: ["verify.mjs"] };
    const prepared = new ContractPolicy().prepare(contract);
    assert.deepEqual(prepared.task.verify, contract.verify);
    for (const verify of [
      { argv: [], timeout_seconds: 10, protected_files: [] },
      { argv: [process.execPath], timeout_seconds: 0, protected_files: [] },
      { argv: [process.execPath], timeout_seconds: 10, protected_files: "x" },
    ]) {
      assert.throws(() => new ContractPolicy().prepare({ ...valid(dir), verify }), ContractError);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract rejects non-legacy C2 until SPEC 3", () => {
  const dir = workspace();
  try {
    const contract = valid(dir);
    contract.c2 = { mode: "enforce" };
    assert.throws(() => new ContractPolicy().prepare(contract), ContractError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract accepts a workspace subdirectory and canonicalizes it", () => {
  const dir = workspace();
  try {
    const nested = join(dir, "nested");
    mkdirSync(nested);
    const prepared = new ContractPolicy().prepare(valid(nested));
    assert.equal(prepared.task.workspace, nested);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
