import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, ROOT_CONVERSATION_ID, type ModelRef } from "@earendil-works/pi-durable";
import { Host } from "../src/host.js";
import { NfControl } from "../src/docs.js";
import { JudgeUnavailableError, ModelJudge, validateDecision, type Judge } from "../src/judge.js";
import type { EvidenceSnapshot } from "../src/evidence.js";

const MODEL: ModelRef = { provider: "faux", modelId: "faux-model" };

function snapshot(): EvidenceSnapshot {
  return {
    snapshot_id: "snap-1",
    task_id: "task-1",
    task_version: 1,
    worker_thread_id: "conversation-1",
    worker_turn_id: "round-1",
    task: {
      schema_version: 1,
      task_id: "task-1",
      workspace: "/workspace",
      goal: "goal",
      acceptance: [{ id: "A1", text: "done" }],
      authorization: "local only",
      c2: { mode: "legacy" },
      limits: { max_worker_turns: null, max_minutes: null },
    },
    evidence: [],
    evidence_complete: true,
    omissions: [],
  };
}

function fauxModels(text: string): ReturnType<typeof createModels> {
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "faux-model", name: "Faux Model" }] });
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage(text)]);
  return models;
}

function assistant(text: string, usage = 10): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "stub",
    model: "stub-model",
    usage: {
      input: usage,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: usage + 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as AssistantMessage;
}

test("ModelJudge calls the configured model and records usage and raw output", async () => {
  const decision = {
    action: "CONTINUE",
    reason: "more work",
    evidence_ids: [],
    next_message: "Run the tests.",
    external: null,
  };
  const judge = new ModelJudge(fauxModels(JSON.stringify(decision)), {
    model: MODEL,
    maxAttempts: 1,
    timeoutMs: 1_000,
  });
  const raw = await judge.decide(snapshot());
  const validated = validateDecision(raw, snapshot());
  assert.equal(validated.action, "CONTINUE");
  assert.equal(judge.lastUsage?.provider, "faux");
  assert.equal(judge.lastUsage?.attempts, 1);
  assert.match(judge.lastRawOutput ?? "", /Run the tests/);
});

test("ModelJudge retries transient failures with a bounded attempt count", async () => {
  let attempts = 0;
  const stub = {
    getModel: () => ({ provider: "stub", id: "stub-model" }),
    complete: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("transient provider failure");
      return assistant(JSON.stringify({
        action: "CONTINUE",
        reason: "retry",
        evidence_ids: [],
        next_message: "Continue.",
        external: null,
      }));
    },
  } as unknown as Models;
  const judge = new ModelJudge(stub, {
    model: { provider: "stub", modelId: "stub-model" },
    maxAttempts: 3,
    retryDelaysMs: [1, 1],
    timeoutMs: 1_000,
  });
  const raw = await judge.decide(snapshot());
  assert.equal(validateDecision(raw, snapshot()).action, "CONTINUE");
  assert.equal(attempts, 3);
  assert.equal(judge.lastUsage?.attempts, 3);
});

test("ModelJudge times out and reports an unavailable judge", async () => {
  const stub = {
    getModel: () => ({ provider: "stub", id: "stub-model" }),
    complete: async (
      _model: unknown,
      _context: unknown,
      options?: { signal?: AbortSignal },
    ) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    }),
  } as unknown as Models;
  const judge = new ModelJudge(stub, {
    model: { provider: "stub", modelId: "stub-model" },
    maxAttempts: 1,
    timeoutMs: 20,
  });
  await assert.rejects(judge.decide(snapshot()), JudgeUnavailableError);
});

test("a non-output judge failure moves the task to INTERRUPTED", async () => {
  const judge: Judge = {
    async decide() {
      throw new Error("provider down");
    },
  };
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-interrupted-"));
  const host = await Host.open({
    storage: new MemoryStorage(),
    models: fauxModels("done"),
    model: MODEL,
    contract: {
      schema_version: 1,
      task_id: "interrupted-task",
      workspace,
      goal: "goal",
      acceptance: [{ id: "A1", text: "done" }],
      authorization: "local only",
      limits: { max_worker_turns: null, max_minutes: null },
    },
    db_path: join(workspace, "state.sqlite"),
    judge,
  });
  try {
    await host.start();
    await host.waitForIdle();
    const status = await host.inspect();
    assert.equal(status.status, "INTERRUPTED");
    const control = await host.harness.snapshot(NfControl, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.match(control?.last_error ?? "", /provider down/);
  } finally {
    await host.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("judge usage is persisted for the status projection", async () => {
  const judge: Judge & { lastUsage: NonNullable<Judge["lastUsage"]> } = {
    lastUsage: { provider: "stub", model: "stub-model", input: 12, output: 3, cost: 0.02, attempts: 1 },
    async decide(snapshot) {
      const evidence = snapshot.evidence[0];
      if (!evidence) throw new Error("no evidence");
      return {
        action: "DONE",
        reason: "evidence",
        evidence_ids: [evidence.id],
        next_message: "",
        external: null,
      };
    },
  };
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-usage-"));
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "faux-model", name: "Faux Model" }] });
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "echo evidence" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("finished"),
  ]);
  const host = await Host.open({
    storage: new MemoryStorage(),
    models,
    model: MODEL,
    contract: {
      schema_version: 1,
      task_id: "usage-task",
      workspace,
      goal: "goal",
      acceptance: [{ id: "A1", text: "done" }],
      authorization: "local only",
      limits: { max_worker_turns: null, max_minutes: null },
    },
    db_path: join(workspace, "state.sqlite"),
    judge,
  });
  try {
    await host.start();
    await host.waitForIdle();
    const status = await host.inspect();
    assert.equal(status.judge_usage?.input, 12);
    assert.equal(status.judge_usage?.cost, 0.02);
  } finally {
    await host.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
