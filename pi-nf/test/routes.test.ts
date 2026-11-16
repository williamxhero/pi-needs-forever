import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import type { Decision } from "../src/judge.js";
import {
  type C2Context,
  type RouteAttempt,
  type RouteCandidate,
  type RouteCatalogEntry,
  ingestInventory,
  validateC2Decision,
} from "../src/routes.js";

const now = new Date().toISOString();
const evidenceA = { id: "catalog:a.txt:aaa", source: "probe", reference: "workspace-file:a.txt", content_sha256: "a".repeat(64), observed_at: now };
const evidenceB = { id: "catalog:b.txt:bbb", source: "probe", reference: "workspace-file:b.txt", content_sha256: "b".repeat(64), observed_at: now };

function entry(id: string, evidence: typeof evidenceA, status: RouteCatalogEntry["status"] = "observed"): RouteCatalogEntry {
  return {
    route_id: `local-artifact:${id}`,
    resource: { kind: "artifact", id },
    operation: "read-local-artifact",
    status,
    authorization: { status: "authorized", evidence_ids: [evidence.id] },
    evidence: [evidence],
    inventory_only: true,
  };
}

function candidate(id: string, hypothesis: string, evidenceId: string, check: RouteCandidate["discriminating_check"] = null): RouteCandidate {
  return {
    route_id: `local-artifact:${id}`,
    resource: { kind: "artifact", id },
    operation: "read-local-artifact",
    hypothesis_id: hypothesis,
    hypothesis: `Read ${id} to establish the next fact.`,
    expected_evidence: [`content of ${id}`],
    status: "observed",
    evidence_ids: [evidenceId],
    actions: [`Read ${id} and report the relevant fact.`],
    expected_signal: "A concrete local fact.",
    risk: "The artifact may be irrelevant.",
    fallback: { route_id: null, when: "No relevant fact is found." },
    discriminating_check: check,
  };
}

function context(attempts: RouteAttempt[] = []): C2Context {
  return {
    mode: "enforce",
    context_complete: true,
    catalog: { entries: [entry("a.txt", evidenceA), entry("b.txt", evidenceB)] },
    ledger: { attempts },
    current_plan: null,
    instruction: "",
    omissions: [],
  };
}

function decision(candidates: RouteCandidate[], selected = candidates[0]!.route_id, single: string | null = null): Decision {
  return {
    action: "CONTINUE",
    reason: "route",
    evidence_ids: [],
    next_message: "placeholder",
    external: null,
    diagnosis: { class: "evidence_gap", statement: "need a fact", evidence_ids: [] },
    route_plan: {
      plan_id: "plan-1",
      candidates,
      selected_route_id: selected,
      selection_reason: "local evidence first",
      single_route_reason: single,
      success_condition: "fact established",
      stop_condition: "fact recorded",
    },
  };
}

function attempt(hypothesis: string, outcome: RouteAttempt["outcome"] = "failure"): RouteAttempt {
  return {
    attempt_id: `attempt-${hypothesis}`,
    task_version: 1,
    route_id: "local-artifact:a.txt",
    route: { resource: { kind: "artifact", id: "a.txt" }, operation: "read-local-artifact", hypothesis_id: hypothesis },
    outcome,
    evidence_ids: [evidenceA.id],
    evidence: [evidenceA],
    recorded_at: now,
  };
}

test("C2 accepts two materially different observed candidates and derives next_message", () => {
  const admitted = validateC2Decision(decision([candidate("a.txt", "h-a", evidenceA.id), candidate("b.txt", "h-b", evidenceB.id)]), context());
  assert.equal(admitted.next_message, "Read a.txt and report the relevant fact.");
});

test("C2 requires two materially different candidates or a single-route reason", () => {
  assert.throws(() => validateC2Decision(decision([candidate("a.txt", "h-a", evidenceA.id)]), context()));
  assert.doesNotThrow(() => validateC2Decision(decision([candidate("a.txt", "h-a", evidenceA.id)], "local-artifact:a.txt", "Only one bounded local fact remains."), context()));
});

test("C2 rejects an observed route without catalog evidence", () => {
  const ungrounded = candidate("a.txt", "h", "missing-evidence");
  assert.throws(() => validateC2Decision(decision([ungrounded, candidate("b.txt", "h-b", evidenceB.id)]), context()));
});

test("C2 rejects a third equivalent no-progress attempt", () => {
  const attempts = [attempt("h1"), attempt("h2"), attempt("h3")];
  assert.throws(() => validateC2Decision(decision([candidate("a.txt", "h4", evidenceA.id), candidate("b.txt", "h-b", evidenceB.id)]), context(attempts)), /no_progress/);
});

test("C2 requires a new hypothesis or discriminating check after a same-family failure", () => {
  assert.throws(() => validateC2Decision(decision([candidate("a.txt", "h1", evidenceA.id), candidate("b.txt", "h-b", evidenceB.id)]), context([attempt("h1")])), /change_hypothesis/);
  assert.doesNotThrow(() => validateC2Decision(decision([candidate("a.txt", "h1", evidenceA.id, { description: "check the file header", evidence_ids: [evidenceA.id] }), candidate("b.txt", "h-b", evidenceB.id)]), context([attempt("h1")])));
});

test("WAIT_EXTERNAL requires every catalog route attempted or excluded with evidence", () => {
  const incomplete = context([attempt("h1")]);
  const wait: Decision = {
    action: "WAIT_EXTERNAL",
    reason: "blocked",
    evidence_ids: [evidenceA.id],
    next_message: "",
    external: { missing: "quota", attempted: ["local-artifact:a.txt"], why_no_other_work: "exhausted", resume_when: "quota resets" },
  };
  assert.throws(() => validateC2Decision(wait, incomplete), /local-artifact:b.txt/);
  const complete = context([attempt("h1"), { ...attempt("b"), route_id: "local-artifact:b.txt", route: { resource: { kind: "artifact", id: "b.txt" }, operation: "read-local-artifact", hypothesis_id: "b" }, evidence: [evidenceB], evidence_ids: [evidenceB.id] }]);
  const accepted = validateC2Decision({ ...wait, external: { ...wait.external!, attempted: ["local-artifact:a.txt", "local-artifact:b.txt"] } }, complete);
  assert.equal(accepted.action, "WAIT_EXTERNAL");
});

test("inventory hints are independently read and never grant missing artifacts", () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-inventory-"));
  try {
    writeFileSync(join(workspace, "cache.csv"), "a,b;1,2");
    const value = { nf_route_inventory: { schema_version: 1, task_id: "task-1", task_version: 1, routes: [
      { route_id: "route-cache", resource: { kind: "artifact", id: "cache.csv" }, operation: "read-local-artifact" },
      { route_id: "route-missing", resource: { kind: "artifact", id: "missing.csv" }, operation: "read-local-artifact" },
      { route_id: "route-provider", resource: { kind: "provider", id: "tushare" }, operation: "call-api" },
    ] } };
    const entries = ingestInventory(workspace, value, "task-1", 1);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].route_id, "route-cache");
    assert.equal(entries[0].status, "observed");
    assert.match(entries[0].evidence[0].content_sha256, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
