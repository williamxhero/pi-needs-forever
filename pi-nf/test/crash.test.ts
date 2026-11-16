import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ROOT_CONVERSATION_ID, type ModelRef } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { readContractFile } from "../src/contract.js";
import { NfDirection } from "../src/docs.js";
import { Host } from "../src/host.js";
import { FixtureJudge } from "../src/judge.js";

const MODEL: ModelRef = { provider: "faux", modelId: "faux-model" };
const PACKAGE_ROOT = process.cwd();

function contract(workspace: string): Record<string, unknown> {
  return {
    schema_version: 1,
    task_id: "crash-task",
    workspace,
    goal: "Survive a crash",
    acceptance: [{ id: "A1", text: "The task can resume" }],
    authorization: "Only edit this workspace",
    limits: { max_worker_turns: null, max_minutes: null },
  };
}

function recoveryModels(): ReturnType<typeof createModels> {
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "faux-model", name: "Faux Model" }] });
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage("Recovered first answer."),
    fauxAssistantMessage("Recovered second answer."),
  ]);
  return models;
}

async function until<T>(operation: () => Promise<T | undefined>, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`timed out waiting for condition: ${lastError instanceof Error ? lastError.message : String(lastError ?? "no value")}`);
}

async function startChild(workspace: string, db: string, taskPath: string, marker: string, mode: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [join(PACKAGE_ROOT, "dist/test/fixtures/crash-host.js")], {
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      NF_DB: db,
      NF_TASK: taskPath,
      NF_MARKER: marker,
      NF_MODE: mode,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const exited = once(child, "exit").then(([code]) => code as number);
  // Surface an early exit as a useful error.
  const early = await Promise.race([
    exited.then((code) => ({ code })),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1_000)),
  ]);
  if (early && early.code !== 0) throw new Error(`crash fixture exited early (${early.code}): ${stderr}`);
  return child;
}

async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function reopen(db: string, taskPath: string, judge = new FixtureJudge({
  action: "CONTINUE",
  reason: "resume after crash",
  evidence_ids: [],
  next_message: "Continue after recovery.",
  external: null,
})): Promise<Host> {
  const host = await Host.open({
    storage: await openNodeSqliteStorage(db),
    models: recoveryModels(),
    model: MODEL,
    contract: readContractFile(taskPath),
    db_path: db,
    judge,
    context: BACKGROUND_CONTEXT,
  });
  host.harness.resume();
  return host;
}

test("a crash during the judge snapshot resumes without duplicating a direction", { timeout: 30_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-crash-snapshot-"));
  const db = join(workspace, "state.sqlite");
  const taskPath = join(workspace, "task.json");
  const marker = join(workspace, "marker");
  writeFileSync(taskPath, JSON.stringify(contract(workspace)));
  const child = await startChild(workspace, db, taskPath, marker, "snapshot");
  try {
    await until(async () => existsSync(marker) ? true : undefined);
  } finally {
    await killChild(child);
  }
  const host = await reopen(db, taskPath);
  try {
    await until(async () => {
      const status = await host.inspect();
      return status.last_round ? status : undefined;
    });
    const conversation = await host.harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.ok(conversation);
    const entries = await conversation.entries({ order: "ascending" }, 500, undefined, BACKGROUND_CONTEXT);
    const directions = entries.items.filter((entry) => NfDirection.is(entry));
    assert.ok(directions.length >= 1);
    const requestIds = directions.map((entry) => entry.data.request_id);
    assert.equal(new Set(requestIds).size, requestIds.length);
  } finally {
    await host.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a crash during the judge resumes the judge phase without duplicating a direction", { timeout: 30_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-crash-judge-"));
  const db = join(workspace, "state.sqlite");
  const taskPath = join(workspace, "task.json");
  const marker = join(workspace, "marker");
  writeFileSync(taskPath, JSON.stringify(contract(workspace)));
  const child = await startChild(workspace, db, taskPath, marker, "judge");
  try {
    await until(async () => existsSync(marker) ? true : undefined);
  } finally {
    await killChild(child);
  }
  const host = await reopen(db, taskPath);
  try {
    await until(async () => {
      const status = await host.inspect();
      return status.last_round ? status : undefined;
    });
    const conversation = await host.harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.ok(conversation);
    const entries = await conversation.entries({ order: "ascending" }, 500, undefined, BACKGROUND_CONTEXT);
    const directions = entries.items.filter((entry) => NfDirection.is(entry));
    assert.ok(directions.length >= 1);
    const requestIds = directions.map((entry) => entry.data.request_id);
    assert.equal(new Set(requestIds).size, requestIds.length);
  } finally {
    await host.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a crash after a committed direction does not duplicate it", { timeout: 30_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-crash-delivery-"));
  const db = join(workspace, "state.sqlite");
  const taskPath = join(workspace, "task.json");
  const marker = join(workspace, "marker");
  writeFileSync(taskPath, JSON.stringify(contract(workspace)));
  const child = await startChild(workspace, db, taskPath, marker, "delivery");
  let originalRound: string | undefined;
  try {
    const status = await until(async () => {
      const current = await Host.status(db);
      return current.delivery?.stage === "submitted" ? current : undefined;
    });
    originalRound = status.last_round?.round_id;
    assert.ok(originalRound);
  } finally {
    await killChild(child);
  }
  const host = await reopen(db, taskPath);
  try {
    await until(async () => {
      const status = await host.inspect();
      return status.last_round ? status : undefined;
    });
    const conversation = await host.harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.ok(conversation);
    const entries = await conversation.entries({ order: "ascending" }, 500, undefined, BACKGROUND_CONTEXT);
    const directions = entries.items.filter((entry) => NfDirection.is(entry));
    const matching = directions.filter((entry) => entry.data.round_id === originalRound);
    assert.equal(matching.length, 1);
  } finally {
    await host.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
