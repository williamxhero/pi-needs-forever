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
import { NfControl, NfDirection, NfEvent } from "../src/docs.js";
import { FixtureJudge, type Judge } from "../src/judge.js";
import { TaskDoneError } from "../src/types.js";

const MODEL: ModelRef = { provider: "faux", modelId: "faux-model" };

function sequence(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]): ReturnType<typeof createModels> {
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "faux-model", name: "Faux Model" }] });
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  return models;
}

function textModels(text: string): ReturnType<typeof createModels> {
  return sequence([fauxAssistantMessage(text)]);
}

function contract(workspace: string): Record<string, unknown> {
  return {
    schema_version: 1,
    task_id: "delivery-task",
    workspace,
    goal: "Implement the feature",
    acceptance: [{ id: "A1", text: "The feature works" }],
    authorization: "Only edit this workspace",
    limits: { max_worker_turns: null, max_minutes: null },
  };
}

test("CONTINUE is delivered as one deterministic nf.direction submission and the next run can finish", async () => {
  let calls = 0;
  const judge: Judge = {
    async decide(snapshot) {
      calls += 1;
      if (calls === 1) {
        return {
          action: "CONTINUE",
          reason: "No evidence yet.",
          evidence_ids: [],
          next_message: "Run the tests and report the result.",
          external: null,
        };
      }
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
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-delivery-"));
  const host = await Host.open({
    storage: new MemoryStorage(),
    models: sequence([
      fauxAssistantMessage("I am done."),
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo evidence" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Finished with evidence."),
    ]),
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
    assert.equal(calls, 2);

    const conversation = await host.harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.ok(conversation);
    const entries = await conversation.entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT);
    const directions = entries.items.filter((entry) => NfDirection.is(entry));
    assert.equal(directions.length, 1);
    const direction = directions[0]!;
    assert.equal((direction.data.decision as { action?: string }).action, "CONTINUE");
    assert.equal(direction.data.round_id.length > 0, true);
    assert.match(direction.data.request_id, /^nf:direction:delivery-task:1:/);
    const judgeStarts = entries.items.filter((entry) => {
      const data = entry.data as { type?: string } | undefined;
      return entry.kind === NfEvent.kind && data?.type === "nf.judge_started";
    });
    assert.equal(judgeStarts.length, 2);
    const control = await host.harness.snapshot(NfControl, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.equal(control?.input_epoch, 0);
  } finally {
    await host.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("input during judging supersedes the pending direction", async () => {
  let calls = 0;
  let releaseFirst: (() => void) | undefined;
  let firstStarted: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  const judge: Judge = {
    async decide(snapshot) {
      calls += 1;
      if (calls === 1) {
        firstStarted?.();
        await gate;
        return {
          action: "CONTINUE",
          reason: "stale direction",
          evidence_ids: [],
          next_message: "This direction must not be delivered.",
          external: null,
        };
      }
      const first = snapshot.evidence[0];
      if (!first) throw new Error("second judge has no evidence");
      return {
        action: "DONE",
        reason: "new input run has evidence",
        evidence_ids: [first.id],
        next_message: "",
        external: null,
      };
    },
  };
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-supersede-"));
  const host = await Host.open({
    storage: new MemoryStorage(),
    models: sequence([
      fauxAssistantMessage("I am done."),
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo evidence" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("New input handled."),
    ]),
    model: MODEL,
    contract: contract(workspace),
    db_path: join(workspace, "state.sqlite"),
    judge,
  });
  try {
    await host.start();
    await started;
    const send = await host.send("Actually, do this instead.");
    assert.equal(send.input_epoch, 1);
    releaseFirst?.();
    await host.waitForIdle();
    const status = await host.inspect();
    assert.equal(status.status, "DONE");
    const conversation = await host.harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.ok(conversation);
    const entries = await conversation.entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT);
    assert.equal(entries.items.filter((entry) => NfDirection.is(entry)).length, 0);
    const superseded = entries.items.filter((entry) => {
      const data = entry.data as { type?: string } | undefined;
      return entry.kind === NfEvent.kind && data?.type === "nf.round_superseded";
    });
    assert.equal(superseded.length, 1);
    const control = await host.harness.snapshot(NfControl, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.equal(control?.input_epoch, 1);
  } finally {
    await host.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("DONE rejects further human input", async () => {
  const judge: Judge = {
    async decide(snapshot) {
      const first = snapshot.evidence[0];
      assert.ok(first);
      return {
        action: "DONE",
        reason: "evidence",
        evidence_ids: [first.id],
        next_message: "",
        external: null,
      };
    },
  };
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-done-send-"));
  const host = await Host.open({
    storage: new MemoryStorage(),
    models: sequence([
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo evidence" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Finished."),
    ]),
    model: MODEL,
    contract: contract(workspace),
    db_path: join(workspace, "state.sqlite"),
    judge,
  });
  try {
    await host.start();
    await host.waitForIdle();
    await assert.rejects(host.send("one more thing"), TaskDoneError);
  } finally {
    await host.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("WAIT_EXTERNAL is recorded without a direction and human input resumes the task", async () => {
  const judge: Judge = {
    async decide(snapshot) {
      const first = snapshot.evidence[0];
      assert.ok(first);
      return {
        action: "WAIT_EXTERNAL",
        reason: "quota blocked",
        evidence_ids: [first.id],
        next_message: "",
        external: {
          missing: "vendor quota",
          attempted: ["local cache", "direct API"],
          why_no_other_work: "no authorized local route remains",
          resume_when: "quota resets",
        },
      };
    },
  };
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-wait-"));
  const host = await Host.open({
    storage: new MemoryStorage(),
    models: sequence([
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo blocked" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Blocked by quota."),
    ]),
    model: MODEL,
    contract: contract(workspace),
    db_path: join(workspace, "state.sqlite"),
    judge,
  });
  try {
    await host.start();
    await host.waitForIdle();
    const status = await host.inspect();
    assert.equal(status.status, "WAIT_EXTERNAL");
    assert.equal(status.last_decision?.action, "WAIT_EXTERNAL");
    const conversation = await host.harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.ok(conversation);
    const entries = await conversation.entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT);
    assert.equal(entries.items.filter((entry) => NfDirection.is(entry)).length, 0);
    const resumed = await host.send("The quota is available again.");
    assert.equal(resumed.input_epoch, 1);
    const resumedStatus = await host.inspect();
    assert.equal(resumedStatus.status, "ACTIVE");
  } finally {
    await host.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
