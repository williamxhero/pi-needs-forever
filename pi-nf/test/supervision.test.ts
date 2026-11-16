import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, ROOT_CONVERSATION_ID, type ModelRef } from "@earendil-works/pi-durable";
import { Host } from "../src/host.js";
import { NfControl, NfRound } from "../src/docs.js";
import { FixtureJudge, type Judge } from "../src/judge.js";

const MODEL: ModelRef = { provider: "faux", modelId: "faux-model" };

function modelsWithTool(): ReturnType<typeof createModels> {
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "faux-model", name: "Faux Model" }] });
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "echo evidence" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Finished with evidence."),
  ]);
  return models;
}

function modelsWithText(text: string): ReturnType<typeof createModels> {
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "faux-model", name: "Faux Model" }] });
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage(text)]);
  return models;
}

function contract(workspace: string): Record<string, unknown> {
  return {
    schema_version: 1,
    task_id: "judge-task",
    workspace,
    goal: "Implement the feature",
    acceptance: [{ id: "A1", text: "The feature works" }],
    authorization: "Only edit this workspace",
    limits: { max_worker_turns: null, max_minutes: null },
  };
}

test("afterRun creates one judge task and records a CONTINUE decision", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-judge-"));
  const host = await Host.open({
    storage: new MemoryStorage(),
    models: modelsWithText("I am done."),
    model: MODEL,
    contract: contract(workspace),
    db_path: join(workspace, "state.sqlite"),
    judge: new FixtureJudge({
      action: "CONTINUE",
      reason: "No independent evidence yet.",
      evidence_ids: [],
      next_message: "Run the tests and report the result.",
      external: null,
    }),
  });
  try {
    await host.start();
    const deadline = Date.now() + 5_000;
    let status = await host.inspect();
    while (status.last_decision?.action !== "CONTINUE" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = await host.inspect();
    }
    assert.equal(status.status, "ACTIVE");
    assert.equal(status.last_decision?.action, "CONTINUE");
    assert.equal(status.last_round?.round_id !== undefined, true);
    const control = await host.harness.snapshot(NfControl, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.equal(control?.last_decision?.action, "CONTINUE");
    assert.equal(control?.delivery?.stage, "submitted");
    const round = await host.harness.snapshot(NfRound, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.equal(round?.status, "decided");
    assert.equal(round?.evidence_count, 0);

    const conversation = await host.harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.ok(conversation);
    const entries = await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
    const judgeStarts = entries.items.filter((entry) => {
      const data = entry.data as { type?: string } | undefined;
      return entry.kind === "nf.event" && data?.type === "nf.judge_started";
    });
    assert.equal(judgeStarts.length, 1);
  } finally {
    await host.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a DONE decision is accepted only with cited tool evidence", async () => {
  const judge: Judge = {
    async decide(snapshot) {
      const first = snapshot.evidence[0];
      assert.ok(first);
      return {
        action: "DONE",
        reason: "The tool result proves the acceptance item.",
        evidence_ids: [first.id],
        next_message: "",
        external: null,
      };
    },
  };
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-done-"));
  const host = await Host.open({
    storage: new MemoryStorage(),
    models: modelsWithTool(),
    model: MODEL,
    contract: contract(workspace),
    db_path: join(workspace, "state.sqlite"),
    judge,
  });
  try {
    await host.start();
    await host.waitForIdle();
    const status = await host.inspect();
    assert.equal(status.status, "DONE");
    assert.equal(status.last_decision?.action, "DONE");
    const control = await host.harness.snapshot(NfControl, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.equal(control?.status, "DONE");
    const round = await host.harness.snapshot(NfRound, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.equal(round?.evidence_count, 1);
  } finally {
    await host.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("an invalid DONE decision is rejected and cannot set DONE", async () => {
  const judge: Judge = {
    async decide() {
      return {
        action: "DONE",
        reason: "worker says so",
        evidence_ids: ["missing-evidence"],
        next_message: "",
        external: null,
      };
    },
  };
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-reject-"));
  const host = await Host.open({
    storage: new MemoryStorage(),
    models: modelsWithText("Done."),
    model: MODEL,
    contract: contract(workspace),
    db_path: join(workspace, "state.sqlite"),
    judge,
  });
  try {
    await host.start();
    await host.waitForIdle();
    const status = await host.inspect();
    assert.equal(status.status, "ACTIVE");
    assert.equal(status.last_decision, null);
    const control = await host.harness.snapshot(NfControl, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.match(control?.last_error ?? "", /unknown evidence ID/i);
    const round = await host.harness.snapshot(NfRound, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.equal(round?.status, "interrupted");
  } finally {
    await host.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
