import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, ROOT_CONVERSATION_ID, type ModelRef } from "@earendil-works/pi-durable";
import { Host } from "../src/host.js";
import { NfDirection, NfVerify } from "../src/docs.js";
import type { Judge } from "../src/judge.js";

const MODEL: ModelRef = { provider: "faux", modelId: "faux-model" };

function toolModels(): ReturnType<typeof createModels> {
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "faux-model", name: "Faux Model" }] });
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "echo evidence" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Finished."),
  ]);
  return models;
}

function doneJudge(): Judge {
  return {
    async decide(snapshot) {
      const evidence = snapshot.evidence[0];
      if (!evidence) throw new Error("no evidence");
      return {
        action: "DONE",
        reason: "C says evidence is complete.",
        evidence_ids: [evidence.id],
        next_message: "",
        external: null,
      };
    },
  };
}

function contract(workspace: string, exitCode: number): Record<string, unknown> {
  const verifyPath = join(workspace, "verify.mjs");
  writeFileSync(verifyPath, `process.exit(${exitCode});\n`);
  return {
    schema_version: 1,
    task_id: `verify-${exitCode}`,
    workspace,
    goal: "Verify the task",
    acceptance: [{ id: "A1", text: "verification" }],
    authorization: "local only",
    limits: { max_worker_turns: null, max_minutes: null },
    verify: {
      argv: [process.execPath, verifyPath],
      timeout_seconds: 5,
      protected_files: ["verify.mjs"],
    },
  };
}

async function until<T>(operation: () => Promise<T | undefined>, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await operation().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out");
}

test("DONE with a configured verifier passes only after nf.verify", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-verify-pass-"));
  const host = await Host.open({
    storage: new MemoryStorage(),
    models: toolModels(),
    model: MODEL,
    contract: contract(workspace, 0),
    db_path: join(workspace, "state.sqlite"),
    judge: doneJudge(),
  });
  try {
    await host.start();
    await host.waitForIdle();
    const status = await host.inspect();
    assert.equal(status.status, "DONE");
    assert.equal(status.verification.state, "passed");
    const verify = await host.harness.snapshot(NfVerify, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.equal((verify?.last_result as { passed?: boolean } | null)?.passed, true);
  } finally {
    await host.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a failed verifier becomes a repair CONTINUE instead of DONE", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-verify-fail-"));
  const host = await Host.open({
    storage: new MemoryStorage(),
    models: toolModels(),
    model: MODEL,
    contract: contract(workspace, 3),
    db_path: join(workspace, "state.sqlite"),
    judge: doneJudge(),
  });
  try {
    await host.start();
    const status = await until(async () => {
      const current = await host.inspect();
      return current.last_decision?.action === "CONTINUE" ? current : undefined;
    });
    assert.equal(status.status, "ACTIVE");
    assert.equal(status.delivery?.stage, "submitted");
    const verify = await host.harness.snapshot(NfVerify, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.equal((verify?.last_result as { passed?: boolean } | null)?.passed, false);
    const conversation = await host.harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.ok(conversation);
    const entries = await conversation.entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT);
    const directions = entries.items.filter((entry) => NfDirection.is(entry));
    assert.equal(directions.length, 1);
    assert.equal((directions[0]?.data.decision as { action?: string }).action, "CONTINUE");
    assert.match((directions[0]?.data.decision as { next_message?: string }).next_message ?? "", /verification failed/i);
  } finally {
    await host.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a protected file changed before verification becomes a repair, never DONE", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-verify-protected-"));
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const began = new Promise<void>((resolve) => { started = resolve; });
  const judge: Judge = {
    async decide(snapshot) {
      started?.();
      await gate;
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
  const host = await Host.open({
    storage: new MemoryStorage(),
    models: toolModels(),
    model: MODEL,
    contract: contract(workspace, 0),
    db_path: join(workspace, "state.sqlite"),
    judge,
  });
  try {
    await host.start();
    await began;
    writeFileSync(join(workspace, "verify.mjs"), "process.exit(0); // changed\n");
    release?.();
    const status = await until(async () => {
      const current = await host.inspect();
      return current.last_decision?.action === "CONTINUE" ? current : undefined;
    });
    assert.equal(status.status, "ACTIVE");
    const verify = await host.harness.snapshot(NfVerify, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    const result = verify?.last_result as { passed?: boolean; protected_before?: unknown[] } | null;
    assert.equal(result?.passed, false);
    assert.ok((result?.protected_before?.length ?? 0) > 0);
  } finally {
    await host.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
