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
import { NfDirection, NfRoute } from "../src/docs.js";
import type { C2Context, RouteCandidate } from "../src/routes.js";

const MODEL: ModelRef = { provider: "faux", modelId: "faux-model" };

function candidate(routeId: string, artifact: string, evidenceId: string): RouteCandidate {
  return {
    route_id: routeId,
    resource: { kind: "artifact", id: artifact },
    operation: "read-local-artifact",
    hypothesis_id: `inspect-${artifact}`,
    hypothesis: `Read ${artifact} to establish the next fact.`,
    expected_evidence: [`content of ${artifact}`],
    status: "observed",
    evidence_ids: [evidenceId],
    actions: [`Read ${artifact} and report the relevant fact.`],
    expected_signal: "A concrete local fact.",
    risk: "The file may be irrelevant.",
    fallback: { route_id: null, when: "No relevant fact is found." },
    discriminating_check: null,
  };
}

test("C2 enforce admits a local-artifact route, records execution, and reaches DONE", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-c2-"));
  const db = join(workspace, "state.sqlite");
  writeFileSync(join(workspace, "a.txt"), "alpha fact\n");
  writeFileSync(join(workspace, "b.txt"), "beta fact\n");
  let calls = 0;
  const judge = {
    async decide(snapshot: { evidence: { id: string; value: unknown }[]; c2?: C2Context }) {
      calls += 1;
      if (calls === 1) {
        const context = snapshot.c2;
        assert.ok(context);
        const a = context.catalog.entries.find((entry) => entry.resource.id === "a.txt");
        const b = context.catalog.entries.find((entry) => entry.resource.id === "b.txt");
        assert.ok(a && b);
        return {
          action: "CONTINUE",
          reason: "Read a local fact before changing code.",
          evidence_ids: [],
          next_message: "placeholder",
          external: null,
          diagnosis: { class: "evidence_gap", statement: "Need a local fact.", evidence_ids: [] },
          route_plan: {
            plan_id: "plan-c2",
            candidates: [candidate(a.route_id, "a.txt", a.evidence[0]!.id), candidate(b.route_id, "b.txt", b.evidence[0]!.id)],
            selected_route_id: a.route_id,
            selection_reason: "a.txt is the smallest source.",
            single_route_reason: null,
            success_condition: "The fact is read.",
            stop_condition: "The fact is recorded.",
          },
        };
      }
      const evidence = snapshot.evidence[0];
      assert.ok(evidence);
      return {
        action: "DONE",
        reason: "The local fact and command result are complete evidence.",
        evidence_ids: [evidence.id],
        next_message: "",
        external: null,
      };
    },
  };
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "faux-model", name: "Faux Model" }] });
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage("I am done."),
    fauxAssistantMessage([fauxToolCall("bash", { command: "cat a.txt" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Read alpha fact."),
  ]);
  const host = await Host.open({
    storage: new MemoryStorage(),
    models,
    model: MODEL,
    contract: {
      schema_version: 1,
      task_id: "c2-task",
      workspace,
      goal: "Use a local fact",
      acceptance: [{ id: "A1", text: "fact used" }],
      authorization: "local only",
      c2: { mode: "enforce" },
      limits: { max_worker_turns: null, max_minutes: null },
    },
    db_path: db,
    judge,
  });
  try {
    await host.start();
    await host.waitForIdle();
    const status = await host.inspect();
    assert.equal(status.status, "DONE");
    assert.equal(status.route.mode, "enforce");
    assert.equal(status.route.attempts, 1);
    assert.equal(status.route.last_outcome, "diagnostic");
    const conversation = await host.harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.ok(conversation);
    const entries = await conversation.entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT);
    const directions = entries.items.filter((entry) => NfDirection.is(entry));
    assert.equal(directions.length, 1);
    assert.match(directions[0]!.data.route_id ?? "", /local-artifact:a.txt/);
    const routeDoc = await host.harness.snapshot(NfRoute, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.equal(routeDoc?.ledger.length, 1);
  } finally {
    await host.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
