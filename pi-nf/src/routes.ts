import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { JsonValue } from "@earendil-works/chord/json";
import type { Decision } from "./judge.js";
import { JudgeOutputError } from "./judge.js";

export type C2Mode = "enforce" | "shadow" | "legacy";
export type RouteStatus = "observed" | "candidate" | "blocked" | "exhausted" | "forbidden" | "unknown";
export type RouteOutcome = "failure" | "transient_failure" | "diagnostic";

export type RouteIdentity = {
  resource: { kind: string; id: string };
  operation: string;
  hypothesis_id: string;
};

export type RouteEvidence = {
  id: string;
  source: string;
  reference: string;
  content_sha256: string;
  observed_at: string;
  summary?: string;
};

export type RouteCatalogEntry = {
  route_id: string;
  resource: { kind: string; id: string };
  operation: string;
  status: RouteStatus;
  authorization: { status: string; evidence_ids: string[] };
  evidence: RouteEvidence[];
  inventory_only?: boolean;
  last_success?: { at: string; evidence_ids: string[] };
  capabilities?: string[];
};

export type RouteDiscriminatingCheck = { description: string; evidence_ids: string[] };
export type RouteAttempt = {
  attempt_id: string;
  task_version: number;
  route_id: string;
  route: RouteIdentity;
  outcome: RouteOutcome;
  evidence_ids: string[];
  evidence: RouteEvidence[];
  failure_class?: string;
  retry_condition?: { kind: string; not_before: string; evidence_ids: string[] };
  discriminating_check?: RouteDiscriminatingCheck;
  recorded_at: string;
};

export type RouteExecution = {
  plan_id: string;
  route_id: string;
  route: RouteIdentity;
  evidence: RouteEvidence[];
  lifecycle_fence: string;
  confirmed: boolean;
  source_round_id: string;
};

export type C2Context = {
  mode: C2Mode;
  context_complete: boolean;
  catalog: { entries: RouteCatalogEntry[] };
  ledger: { attempts: RouteAttempt[] };
  current_plan: JsonValue | null;
  instruction: string;
  omissions: string[];
};

export type RouteState = {
  catalog: RouteCatalogEntry[];
  ledger: RouteAttempt[];
  execution: RouteExecution | null;
};

export type Diagnosis = {
  class: "provider_limit" | "authentication" | "implementation" | "evidence_gap" | "external_dependency" | "unknown";
  statement: string;
  evidence_ids: string[];
};

export type RouteCandidate = RouteIdentity & {
  route_id: string;
  hypothesis: string;
  expected_evidence: string[];
  status: RouteStatus;
  evidence_ids: string[];
  actions: string[];
  expected_signal: string;
  risk: string;
  fallback: { route_id: string | null; when: string };
  discriminating_check: RouteDiscriminatingCheck | null;
  diagnostic_class?: string;
  target_resource_ids?: string[];
};

export type RoutePlan = {
  plan_id: string;
  candidates: RouteCandidate[];
  selected_route_id: string;
  selection_reason: string;
  single_route_reason: string | null;
  success_condition: string;
  stop_condition: string;
};

export function routeFamily(route: Pick<RouteCandidate, "resource" | "operation">): string {
  return `${route.resource.kind}:${route.resource.id}:${route.operation}`.toLowerCase();
}

export function routeFingerprint(route: Pick<RouteCandidate, "resource" | "operation" | "hypothesis_id">): string {
  return `${routeFamily(route)}:${route.hypothesis_id}`.toLowerCase();
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new JudgeOutputError(`${field} must be an object.`);
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new JudgeOutputError(`${field} must be a nonempty string.`);
  return value;
}

function exact(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new JudgeOutputError("C2 route object has missing or unknown fields.");
  }
}

function knownEvidence(context: C2Context, currentEvidence: string[] = []): Set<string> {
  return new Set([
    ...currentEvidence,
    ...context.catalog.entries.flatMap((entry) => entry.evidence.map((item) => item.id)),
    ...context.ledger.attempts.flatMap((attempt) => attempt.evidence.map((item) => item.id)),
  ]);
}

function ids(value: unknown, field: string, known: Set<string>): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !known.has(entry))) {
    throw new JudgeOutputError(`${field} references unknown evidence IDs.`);
  }
  return value as string[];
}

export function discoverLocalRoutes(workspace: string, now = new Date().toISOString()): RouteCatalogEntry[] {
  let files: string[];
  try {
    files = readdirSync(workspace).sort().filter((name) => !name.startsWith(".") && !/(?:secret|credential|token|password|auth|cookie|private|\.pem$|\.key$)/i.test(name)).slice(0, 8);
  } catch {
    return [];
  }
  const entries: RouteCatalogEntry[] = [];
  for (const name of files) {
    if (entries.length >= 4) break;
    const path = join(workspace, name);
    try {
      if (!statSync(path).isFile()) continue;
      const content = readFileSync(path);
      if (content.length > 16_384) continue;
      const digest = createHash("sha256").update(content).digest("hex");
      const evidence: RouteEvidence = {
        id: `catalog:${name}:${digest.slice(0, 16)}`,
        source: "probe",
        reference: `workspace-file:${name}`,
        content_sha256: digest,
        observed_at: now,
        summary: `${relative(workspace, path)} (${content.length} bytes)`,
      };
      entries.push({
        route_id: `local-artifact:${name}`,
        resource: { kind: "artifact", id: name },
        operation: "read-local-artifact",
        status: "observed",
        authorization: { status: "authorized", evidence_ids: [evidence.id] },
        evidence: [evidence],
        inventory_only: true,
        last_success: { at: now, evidence_ids: [evidence.id] },
        capabilities: ["B independently read this bounded local file; relevance to acceptance remains unverified."],
      });
    } catch {
      // A racing/missing/locked file is not an observed route.
    }
  }
  return entries;
}

function candidate(value: unknown, context: C2Context, currentEvidence: string[]): RouteCandidate {
  const raw = record(value, "candidate");
  exact(raw, ["route_id", "resource", "operation", "hypothesis_id", "hypothesis", "expected_evidence", "status", "evidence_ids", "actions", "expected_signal", "risk", "fallback", "discriminating_check"], ["diagnostic_class", "target_resource_ids"]);
  const route = raw as unknown as RouteCandidate;
  nonEmpty(route.route_id, "candidate.route_id");
  const resource = record(raw.resource, "candidate.resource");
  exact(resource, ["kind", "id"]);
  nonEmpty(resource.kind, "candidate.resource.kind");
  nonEmpty(resource.id, "candidate.resource.id");
  nonEmpty(route.operation, "candidate.operation");
  nonEmpty(route.hypothesis_id, "candidate.hypothesis_id");
  nonEmpty(route.hypothesis, "candidate.hypothesis");
  if (!Array.isArray(route.expected_evidence) || route.expected_evidence.some((item) => typeof item !== "string")) {
    throw new JudgeOutputError("candidate.expected_evidence must be a string array.");
  }
  if (!["observed", "candidate", "blocked", "exhausted", "forbidden", "unknown"].includes(route.status)) {
    throw new JudgeOutputError("candidate.status is invalid.");
  }
  const known = knownEvidence(context, currentEvidence);
  route.evidence_ids = ids(raw.evidence_ids, "candidate.evidence_ids", known);
  if (!Array.isArray(route.actions) || route.actions.length === 0) throw new JudgeOutputError("candidate.actions must be nonempty.");
  route.actions.forEach((item) => nonEmpty(item, "candidate.actions"));
  nonEmpty(route.expected_signal, "candidate.expected_signal");
  nonEmpty(route.risk, "candidate.risk");
  const fallback = record(raw.fallback, "candidate.fallback");
  exact(fallback, ["route_id", "when"]);
  nonEmpty(fallback.when, "candidate.fallback.when");
  if (fallback.route_id !== null) nonEmpty(fallback.route_id, "candidate.fallback.route_id");
  if (raw.discriminating_check !== null) {
    const check = record(raw.discriminating_check, "candidate.discriminating_check");
    exact(check, ["description", "evidence_ids"]);
    nonEmpty(check.description, "discriminating_check.description");
    check.evidence_ids = ids(check.evidence_ids, "discriminating_check.evidence_ids", known);
  }
  const catalog = context.catalog.entries.find((entry) => entry.route_id === route.route_id);
  if (catalog && (catalog.resource.kind !== route.resource.kind || catalog.resource.id !== route.resource.id || catalog.operation !== route.operation)) {
    throw new JudgeOutputError("C2 route identity must match its catalog entry.");
  }
  if (route.status === "observed" && (!catalog || catalog.status !== "observed" || !route.evidence_ids.some((id) => catalog.evidence.some((proof) => proof.id === id)))) {
    throw new JudgeOutputError("Observed routes require matching catalog evidence.");
  }
  if (["blocked", "forbidden", "exhausted"].includes(route.status) && (!catalog || catalog.status !== route.status || !route.evidence_ids.some((id) => catalog.evidence.some((proof) => proof.id === id)))) {
    throw new JudgeOutputError("Excluded routes require matching catalog evidence.");
  }
  const prose = [route.hypothesis, ...route.actions, route.expected_signal].join(" ");
  if (route.status !== "observed" && /\b(?:is available|is authenticated|credentials? (?:are|is) present|rate.limit (?:is )?clear|verified available)\b|已验证可用|凭据已就绪|已认证可用/i.test(prose)) {
    throw new JudgeOutputError("Ungrounded route availability claim.");
  }
  return route;
}

export function validateC2Decision(decision: Decision, context: C2Context, currentEvidence: string[] = [], mode: C2Mode = context.mode): Decision {
  if (mode === "legacy") return decision;
  if (decision.action !== "CONTINUE") {
    if (decision.diagnosis != null || decision.route_plan != null) throw new JudgeOutputError("Only CONTINUE may carry diagnosis and route_plan.");
    if (decision.action === "WAIT_EXTERNAL") {
      if (!context.context_complete || context.catalog.entries.length === 0) throw new JudgeOutputError("Complete route context is required before WAIT_EXTERNAL.");
      for (const route of context.catalog.entries) {
        const attempts = context.ledger.attempts.filter((attempt) => routeFamily(attempt.route) === routeFamily(route));
        const excluded = ["blocked", "forbidden", "exhausted"].includes(route.status) ||
          attempts.some((attempt) => ["failure", "transient_failure"].includes(attempt.outcome) && attempt.evidence.length > 0);
        if (!excluded || !decision.external?.attempted.some((reason) => reason.includes(route.route_id))) {
          throw new JudgeOutputError(`WAIT_EXTERNAL requires an attempted/excluded route ${route.route_id} with evidence.`);
        }
      }
    }
    return decision;
  }
  if (!decision.diagnosis || !decision.route_plan) {
    if (mode === "shadow") return decision;
    throw new JudgeOutputError("C2 CONTINUE requires diagnosis and route_plan.");
  }
  const diagnosis = record(decision.diagnosis, "diagnosis");
  exact(diagnosis, ["class", "statement", "evidence_ids"]);
  if (!["provider_limit", "authentication", "implementation", "evidence_gap", "external_dependency", "unknown"].includes(String(diagnosis.class))) {
    throw new JudgeOutputError("diagnosis.class is invalid.");
  }
  nonEmpty(diagnosis.statement, "diagnosis.statement");
  const known = knownEvidence(context, currentEvidence);
  ids(diagnosis.evidence_ids, "diagnosis.evidence_ids", known);
  const plan = record(decision.route_plan, "route_plan");
  exact(plan, ["plan_id", "candidates", "selected_route_id", "selection_reason", "single_route_reason", "success_condition", "stop_condition"]);
  nonEmpty(plan.plan_id, "plan_id");
  nonEmpty(plan.selected_route_id, "selected_route_id");
  nonEmpty(plan.selection_reason, "selection_reason");
  nonEmpty(plan.success_condition, "success_condition");
  nonEmpty(plan.stop_condition, "stop_condition");
  if (plan.single_route_reason !== null) nonEmpty(plan.single_route_reason, "single_route_reason");
  if (!Array.isArray(plan.candidates) || plan.candidates.length === 0 || plan.candidates.length > 8) {
    throw new JudgeOutputError("C2 needs one to eight candidates.");
  }
  const candidates = plan.candidates.map((entry) => candidate(entry, context, currentEvidence));
  const selected = candidates.find((entry) => entry.route_id === plan.selected_route_id);
  if (!selected) throw new JudgeOutputError("Selected route is absent from candidates.");
  if (new Set(candidates.map((entry) => entry.route_id)).size !== candidates.length) throw new JudgeOutputError("Duplicate route IDs.");
  if (new Set(candidates.map(routeFamily)).size < 2 && !plan.single_route_reason) {
    throw new JudgeOutputError("C2 requires materially different candidates or a single_route_reason.");
  }
  if (["blocked", "exhausted", "forbidden"].includes(selected.status)) throw new JudgeOutputError("Selected route is not executable.");
  const familyAttempts = context.ledger.attempts.filter((attempt) => routeFamily(attempt.route) === routeFamily(selected));
  if (familyAttempts.length >= 3) throw new JudgeOutputError("C2 repeated route rejected: no_progress_limit.");
  const last = familyAttempts.at(-1);
  if (last && last.outcome !== "diagnostic" && last.route.hypothesis_id === selected.hypothesis_id && !selected.discriminating_check) {
    throw new JudgeOutputError("C2 repeated route rejected: change_hypothesis.");
  }
  const nextMessage = selected.actions.join("\n");
  if (!nextMessage.trim() || nextMessage.length > 3_000) throw new JudgeOutputError("C2 next_message must be a short instruction derived from selected actions.");
  return { ...decision, next_message: nextMessage };
}

export class RoutePolicy {
  project(mode: C2Mode, state: RouteState): C2Context {
    return {
      mode,
      context_complete: true,
      catalog: { entries: state.catalog },
      ledger: { attempts: state.ledger },
      current_plan: state.execution ? { plan_id: state.execution.plan_id, selected_route_id: state.execution.route_id } : null,
      instruction: "Choose a materially different authorized route. Catalog facts need provenance; names do not prove availability. Missing facts require a bounded inventory. WAIT_EXTERNAL requires all catalog routes attempted or excluded.",
      omissions: [],
    };
  }

  admit(decision: Decision, context: C2Context, currentEvidence: string[] = [], mode: C2Mode = context.mode): Decision {
    return validateC2Decision(decision, context, currentEvidence, mode);
  }

  prepare(decision: Decision, context: C2Context, sourceRoundId: string): RouteExecution | null {
    if (decision.action !== "CONTINUE" || !decision.route_plan) return null;
    const plan = decision.route_plan as unknown as RoutePlan;
    const selected = plan.candidates.find((candidate) => candidate.route_id === plan.selected_route_id);
    if (!selected) throw new JudgeOutputError("Selected route is absent.");
    return {
      plan_id: plan.plan_id,
      route_id: selected.route_id,
      route: {
        resource: selected.resource,
        operation: selected.operation,
        hypothesis_id: selected.hypothesis_id,
      },
      evidence: context.catalog.entries.find((entry) => entry.route_id === selected.route_id)?.evidence ?? [],
      lifecycle_fence: JSON.stringify({ plan_id: plan.plan_id, route_id: selected.route_id, sourceRoundId }),
      confirmed: true,
      source_round_id: sourceRoundId,
    };
  }

  capture(execution: RouteExecution | null, evidence: readonly { id: string; value: unknown }[], taskVersion: number): RouteAttempt | null {
    if (!execution) return null;
    const current = evidence.map((entry) => ({ id: entry.id, digest: createHash("sha256").update(JSON.stringify(entry.value)).digest("hex") }));
    const prior = new Set(execution.evidence.map((entry) => entry.content_sha256));
    const progress = current.some((entry) => !prior.has(entry.digest));
    const failed = evidence.some((entry) => /"(?:is_error|isError)":true|"(?:exitCode|exit_code)":-?[1-9]/i.test(JSON.stringify(entry.value)));
    return {
      attempt_id: randomUUID(),
      task_version: taskVersion,
      route_id: execution.route_id,
      route: execution.route,
      outcome: failed ? "failure" : progress ? "diagnostic" : "failure",
      evidence_ids: current.map((entry) => entry.id),
      evidence: execution.evidence,
      recorded_at: new Date().toISOString(),
      ...(failed ? { failure_class: "observed_execution_failure" } : {}),
    };
  }
}

export function ingestInventory(workspace: string, value: unknown, taskId: string, taskVersion: number): RouteCatalogEntry[] {
  const root = record(value, "inventory");
  const inventory = record(root.nf_route_inventory, "nf_route_inventory");
  if (inventory.schema_version !== 1 || inventory.task_id !== taskId || inventory.task_version !== taskVersion) return [];
  if (!Array.isArray(inventory.routes) || inventory.routes.length > 4) return [];
  const entries: RouteCatalogEntry[] = [];
  for (const raw of inventory.routes) {
    const route = record(raw, "inventory.routes[]");
    if (Object.keys(route).some((key) => !["route_id", "resource", "operation"].includes(key))) continue;
    const resource = record(route.resource, "inventory.resource");
    if (resource.kind !== "artifact" || typeof resource.id !== "string" || typeof route.operation !== "string") continue;
    const name = resource.id;
    if (name.includes("..") || name.startsWith("/") || name.includes("\\")) continue;
    try {
      const content = readFileSync(join(workspace, name));
      if (content.length > 16_384) continue;
      const digest = createHash("sha256").update(content).digest("hex");
      const evidence: RouteEvidence = {
        id: `catalog:${name}:${digest.slice(0, 16)}`,
        source: "probe",
        reference: `workspace-file:${name}`,
        content_sha256: digest,
        observed_at: new Date().toISOString(),
        summary: `${name} (${content.length} bytes)`,
      };
      entries.push({
        route_id: String(route.route_id),
        resource: { kind: "artifact", id: name },
        operation: route.operation,
        status: "observed",
        authorization: { status: "authorized", evidence_ids: [evidence.id] },
        evidence: [evidence],
        inventory_only: true,
        last_success: { at: evidence.observed_at, evidence_ids: [evidence.id] },
      });
    } catch {
      // Unsupported/missing artifacts are not observed capabilities.
    }
  }
  return entries;
}

export function ingestInventoryFromEvidence(
  workspace: string,
  evidence: readonly { value: unknown }[],
  taskId: string,
  taskVersion: number,
): RouteCatalogEntry[] {
  const entries: RouteCatalogEntry[] = [];
  for (const item of evidence) {
    const value = item.value as { content?: unknown } | null;
    const text = typeof value?.content === "string" ? value.content : typeof item.value === "string" ? item.value : null;
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as unknown;
      entries.push(...ingestInventory(workspace, parsed, taskId, taskVersion));
    } catch {
      // Not an inventory result.
    }
  }
  return entries;
}

export function routeEvidenceDigest(route: Pick<RouteCandidate, "resource" | "operation">): string {
  return routeFamily(route);
}
