import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ROOT_CONVERSATION_ID, type ModelRef } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NfDirection, NfEvent } from "../src/docs.js";
import { Host } from "../src/host.js";
import type { Judge } from "../src/judge.js";

const MODEL: ModelRef = { provider: "faux", modelId: "faux-model" };

function models(responses: ReturnType<typeof fauxProvider>["setResponses"] extends (value: infer T) => unknown ? T : never): ReturnType<typeof createModels> {
  const collection = createModels();
  const faux = fauxProvider({ models: [{ id: "faux-model", name: "Faux Model" }] });
  collection.setProvider(faux.provider);
  faux.setResponses(responses);
  return collection;
}

function contract(workspace: string): Record<string, unknown> {
  return {
    schema_version: 1,
    task_id: "acceptance-task",
    workspace,
    goal: "Deliver the first pi-nf loop",
    acceptance: [{ id: "A1", text: "The loop can continue and finish with evidence" }],
    authorization: "Only edit this workspace",
    limits: { max_worker_turns: null, max_minutes: null },
  };
}

test("SPEC 1 acceptance: premature done becomes CONTINUE, then tool evidence becomes DONE", { timeout: 20_000 }, async () => {
  let calls = 0;
  const judge: Judge = {
    async decide(snapshot) {
      calls += 1;
      if (calls === 1) {
        return {
          action: "CONTINUE",
          reason: "The first answer has no independent evidence.",
          evidence_ids: [],
          next_message: "Run a real command and report the result.",
          external: null,
        };
      }
      const evidence = snapshot.evidence[0];
      assert.ok(evidence, "the second round must contain tool evidence");
      return {
        action: "DONE",
        reason: "The tool result supports the acceptance item.",
        evidence_ids: [evidence.id],
        next_message: "",
        external: null,
      };
    },
  };
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-acceptance-"));
  const db = join(workspace, "state.sqlite");
  const host = await Host.open({
    storage: await openNodeSqliteStorage(db),
    models: models([
      fauxAssistantMessage("I am done."),
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo evidence" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Finished with evidence."),
    ]),
    model: MODEL,
    contract: contract(workspace),
    db_path: db,
    judge,
  });
  try {
    await host.start();
    await host.waitForIdle();
    const status = await host.inspect();
    assert.equal(status.status, "DONE");
    assert.equal(status.last_decision?.action, "DONE");
    assert.equal(status.evidence_count, 1);
    const conversation = await host.harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.ok(conversation);
    const entries = await conversation.entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT);
    assert.equal(entries.items.filter((entry) => NfDirection.is(entry)).length, 1);
    const decisions = entries.items.filter((entry) => {
      const data = entry.data as { type?: string } | undefined;
      return entry.kind === NfEvent.kind && data?.type === "nf.decision";
    });
    assert.equal(decisions.length, 2);
  } finally {
    await host.close();
  }
  try {
    const readOnly = await Host.status(db);
    assert.equal(readOnly.task_id, "acceptance-task");
    assert.equal(readOnly.status, "DONE");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("SPEC 1 acceptance: WAIT_EXTERNAL is explicit and resumable by human input", { timeout: 20_000 }, async () => {
  const judge: Judge = {
    async decide(snapshot) {
      const evidence = snapshot.evidence[0];
      assert.ok(evidence);
      return {
        action: "WAIT_EXTERNAL",
        reason: "The vendor quota is the only remaining blocker.",
        evidence_ids: [evidence.id],
        next_message: "",
        external: {
          missing: "vendor quota",
          attempted: ["local cache", "authorized API"],
          why_no_other_work: "no authorized local route remains",
          resume_when: "quota resets",
        },
      };
    },
  };
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-acceptance-wait-"));
  const db = join(workspace, "state.sqlite");
  const host = await Host.open({
    storage: await openNodeSqliteStorage(db),
    models: models([
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo quota" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Blocked by quota."),
    ]),
    model: MODEL,
    contract: contract(workspace),
    db_path: db,
    judge,
  });
  try {
    await host.start();
    await host.waitForIdle();
    const status = await host.inspect();
    assert.equal(status.status, "WAIT_EXTERNAL");
    assert.equal(status.last_decision?.action, "WAIT_EXTERNAL");
    const resumed = await host.send("The quota is available again.");
    assert.equal(resumed.input_epoch, 1);
    assert.equal((await host.inspect()).status, "ACTIVE");
  } finally {
    await host.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("SPEC 1 acceptance example contract is syntactically valid and documented", async () => {
  const examplePath = join(process.cwd(), "examples", "task.json");
  const example = JSON.parse(await (await import("node:fs/promises")).readFile(examplePath, "utf8")) as Record<string, unknown>;
  assert.equal(example.schema_version, 1);
  assert.equal(typeof example.goal, "string");
  assert.ok(Array.isArray(example.acceptance));
  assert.equal(typeof example.authorization, "string");
  assert.deepEqual(example.c2, { mode: "legacy" });
  assert.equal(typeof example.limits, "object");
});
