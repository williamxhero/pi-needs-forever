import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, ROOT_CONVERSATION_ID, type ModelRef } from "@earendil-works/pi-durable";
import { Host } from "../src/host.js";
import { NfDirection, NfControl } from "../src/docs.js";
import type { Judge } from "../src/judge.js";
import { NotResumableError } from "../src/types.js";

const MODEL: ModelRef = { provider: "faux", modelId: "faux-model" };

function models(): ReturnType<typeof createModels> {
  const collection = createModels();
  const faux = fauxProvider({ models: [{ id: "faux-model", name: "Faux Model" }] });
  collection.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("resumed")]);
  return collection;
}

function contract(workspace: string, limits: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: 1,
    task_id: "lifecycle-task",
    workspace,
    goal: "lifecycle",
    acceptance: [{ id: "A1", text: "done" }],
    authorization: "local",
    c2: { mode: "legacy" },
    limits,
  };
}

const continueJudge: Judge = {
  async decide() {
    return { action: "CONTINUE", reason: "more", evidence_ids: [], next_message: "continue", external: null };
  },
};

test("max_worker_turns pauses before the next direction and reports usage", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-limit-"));
  const host = await Host.open({
    storage: new MemoryStorage(),
    models: models(),
    model: MODEL,
    contract: contract(workspace, { max_worker_turns: 1, max_minutes: null, max_tokens: null, max_cost: null }),
    db_path: join(workspace, "state.sqlite"),
    judge: continueJudge,
  });
  try {
    await host.start();
    await host.waitForIdle();
    const status = await host.inspect();
    assert.equal(status.status, "PAUSED");
    assert.equal(status.usage.worker_turns, 1);
    const control = await host.harness.snapshot(NfControl, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.equal(control?.pause_reason, "user_limit");
    assert.match(control?.limit_reason ?? "", /turn limit/);
    const conversation = await host.harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.ok(conversation);
    const entries = await conversation.entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT);
    assert.equal(entries.items.filter((entry) => NfDirection.is(entry)).length, 0);
    await assert.rejects(host.send("blocked"), NotResumableError);
  } finally {
    await host.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("pause persists PAUSED before cancellation and resume opens a new window", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-pause-"));
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const began = new Promise<void>((resolve) => { started = resolve; });
  const judge: Judge = {
    async decide(_snapshot, signal) {
      started?.();
      if (signal) {
        await Promise.race([
          gate,
          new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
        ]);
      } else {
        await gate;
      }
      return { action: "CONTINUE", reason: "late", evidence_ids: [], next_message: "stale", external: null };
    },
  };
  const host = await Host.open({
    storage: new MemoryStorage(),
    models: models(),
    model: MODEL,
    contract: contract(workspace, { max_worker_turns: null, max_minutes: null }),
    db_path: join(workspace, "state.sqlite"),
    judge,
  });
  try {
    await host.start();
    await began;
    const paused = await host.pause();
    assert.equal(paused.status, "PAUSED");
    release?.();
    await host.waitForIdle();
    const status = await host.inspect();
    assert.equal(status.status, "PAUSED");
    const conversation = await host.harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.ok(conversation);
    const entries = await conversation.entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT);
    assert.equal(entries.items.filter((entry) => NfDirection.is(entry)).length, 0);
    const before = await host.harness.snapshot(NfControl, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    const resumed = await host.resume();
    assert.equal(resumed.status, "ACTIVE");
    const after = await host.harness.snapshot(NfControl, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.ok((after?.task_version ?? 0) > (before?.task_version ?? 0));
  } finally {
    await host.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("restart-limit interruption requires explicit resume and preserves the contract", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-interrupt-"));
  const host = await Host.open({
    storage: new MemoryStorage(),
    models: models(),
    model: MODEL,
    contract: contract(workspace, { max_worker_turns: null, max_minutes: null }),
    db_path: join(workspace, "state.sqlite"),
  });
  try {
    await host.start();
    await host.waitForIdle();
    await host.markInterrupted("task_interrupted:restart_limit");
    const status = await host.inspect();
    assert.equal(status.status, "INTERRUPTED");
    assert.match(status.last_error ?? "", /restart_limit/);
    await assert.rejects(host.send("blocked"), NotResumableError);
    const resumed = await host.resume();
    assert.equal(resumed.status, "ACTIVE");
    const control = await host.harness.snapshot(NfControl, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.ok((control?.task_version ?? 0) >= 2);
  } finally {
    await host.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
