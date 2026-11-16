import test from "node:test";
import assert from "node:assert/strict";
import { validateDecision } from "../src/judge.js";
import type { EvidenceSnapshot } from "../src/evidence.js";

function snapshot(overrides: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot {
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
    evidence: [
      {
        id: "e1",
        type: "functionCallOutput",
        value: { tool_name: "bash", content: "ok" },
        source: { event_id: "e1" },
      },
    ],
    evidence_complete: true,
    omissions: [],
    ...overrides,
  };
}

const continueDecision = {
  action: "CONTINUE",
  reason: "more work",
  evidence_ids: [],
  next_message: "Run the tests.",
  external: null,
};

test("CONTINUE requires a concrete next message and no external wait", () => {
  const decision = validateDecision(continueDecision, snapshot());
  assert.equal(decision.action, "CONTINUE");
  assert.equal(decision.next_message, "Run the tests.");
  assert.throws(() => validateDecision({ ...continueDecision, next_message: "" }, snapshot()));
  assert.throws(() => validateDecision({ ...continueDecision, external: { missing: "x" } }, snapshot()));
});

test("DONE requires cited independent evidence", () => {
  assert.equal(validateDecision({
    action: "DONE",
    reason: "evidence is complete",
    evidence_ids: ["e1"],
    next_message: "",
    external: null,
  }, snapshot()).action, "DONE");

  assert.throws(() => validateDecision({
    action: "DONE",
    reason: "no proof",
    evidence_ids: [],
    next_message: "",
    external: null,
  }, snapshot()));

  assert.throws(() => validateDecision({
    action: "DONE",
    reason: "invented",
    evidence_ids: ["missing"],
    next_message: "",
    external: null,
  }, snapshot()));
});

test("DONE cannot use an assistant claim as independent evidence", () => {
  const claimOnly = snapshot({
    evidence: [{
      id: "claim",
      type: "assistant_claim",
      value: "done",
      source: { event_id: "claim" },
    }],
  });
  assert.throws(() => validateDecision({
    action: "DONE",
    reason: "worker said so",
    evidence_ids: ["claim"],
    next_message: "",
    external: null,
  }, claimOnly));
});

test("WAIT_EXTERNAL requires a complete external condition and evidence", () => {
  const wait = {
    action: "WAIT_EXTERNAL",
    reason: "blocked",
    evidence_ids: ["e1"],
    next_message: "",
    external: {
      missing: "vendor quota",
      attempted: ["local cache check"],
      why_no_other_work: "all authorized routes failed",
      resume_when: "quota resets",
    },
  };
  assert.equal(validateDecision(wait, snapshot()).action, "WAIT_EXTERNAL");
  assert.throws(() => validateDecision({ ...wait, next_message: "continue anyway" }, snapshot()));
  assert.throws(() => validateDecision({ ...wait, external: { ...wait.external, attempted: [] } }, snapshot()));
});

test("terminal decisions are rejected on incomplete evidence", () => {
  const incomplete = snapshot({ evidence_complete: false, omissions: ["tool output truncated"] });
  assert.throws(() => validateDecision({
    action: "DONE",
    reason: "done",
    evidence_ids: ["e1"],
    next_message: "",
    external: null,
  }, incomplete));
  assert.equal(validateDecision({
    ...continueDecision,
    reason: "gather concise proof",
  }, incomplete).action, "CONTINUE");
});

test("judge output rejects fences, extra fields and unsupported C2", () => {
  assert.throws(() => validateDecision("```json\n" + JSON.stringify(continueDecision) + "\n```", snapshot()));
  assert.throws(() => validateDecision({ ...continueDecision, extra: true }, snapshot()));
  assert.throws(() => validateDecision({ ...continueDecision, route_plan: { candidates: [] } }, snapshot()));
});
