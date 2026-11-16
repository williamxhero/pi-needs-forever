import type { JsonValue } from "@earendil-works/chord/json";
import type { EvidenceSnapshot } from "./evidence.js";

export type DecisionAction = "CONTINUE" | "DONE" | "WAIT_EXTERNAL";

export type ExternalWait = {
  missing: string;
  attempted: string[];
  why_no_other_work: string;
  resume_when: string;
};

export type Decision = {
  action: DecisionAction;
  reason: string;
  evidence_ids: string[];
  next_message: string;
  external: ExternalWait | null;
  diagnosis?: JsonValue | null;
  route_plan?: JsonValue | null;
};

export type DecisionSummary = Pick<Decision, "action" | "reason">;

export const decisionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action", "reason", "evidence_ids", "next_message", "external"],
  properties: {
    action: { type: "string", enum: ["CONTINUE", "DONE", "WAIT_EXTERNAL"] },
    reason: { type: "string" },
    evidence_ids: { type: "array", items: { type: "string" } },
    next_message: { type: "string" },
    external: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["missing", "attempted", "why_no_other_work", "resume_when"],
          properties: {
            missing: { type: "string" },
            attempted: { type: "array", items: { type: "string" } },
            why_no_other_work: { type: "string" },
            resume_when: { type: "string" },
          },
        },
      ],
    },
    diagnosis: {},
    route_plan: {},
  },
} as const;

export class JudgeOutputError extends Error {
  override name = "JudgeOutputError";
}

function recordOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new JudgeOutputError("Judge output must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new JudgeOutputError(`${field} must be a nonempty string.`);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key))) {
    throw new JudgeOutputError(`Judge output is missing a required field: ${required.find((key) => !Object.hasOwn(value, key))}.`);
  }
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new JudgeOutputError(`Judge output has an unknown field: ${unknown}.`);
}

function evidenceIds(value: unknown, snapshot: EvidenceSnapshot): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new JudgeOutputError("evidence_ids must be an array of nonempty strings.");
  }
  const known = new Set(snapshot.evidence.map((entry) => entry.id));
  for (const id of value as string[]) {
    if (!known.has(id)) throw new JudgeOutputError(`Judge referenced unknown evidence ID: ${id}.`);
  }
  return value as string[];
}

function independentEvidence(ids: string[], snapshot: EvidenceSnapshot): void {
  const independentTypes = new Set(["commandExecution", "fileChange", "functionCallOutput", "verification_result"]);
  const hasIndependent = snapshot.evidence.some(
    (entry) => ids.includes(entry.id) && entry.source !== undefined && independentTypes.has(entry.type),
  );
  if (!hasIndependent) {
    throw new JudgeOutputError("DONE/WAIT_EXTERNAL require independent tool, file or verification evidence, not worker claims.");
  }
}

export function validateDecision(raw: unknown, snapshot: EvidenceSnapshot): Decision {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new JudgeOutputError("Judge output must be one JSON object, without fences or extra text.");
    }
  }
  const object = recordOf(value);
  exactKeys(object, ["action", "reason", "evidence_ids", "next_message", "external"], ["diagnosis", "route_plan"]);
  const action = object.action;
  if (action !== "CONTINUE" && action !== "DONE" && action !== "WAIT_EXTERNAL") {
    throw new JudgeOutputError("Judge action must be CONTINUE, DONE or WAIT_EXTERNAL.");
  }
  const reason = nonEmpty(object.reason, "reason");
  const ids = evidenceIds(object.evidence_ids, snapshot);
  const nextMessage = typeof object.next_message === "string" ? object.next_message : null;
  if (nextMessage === null) throw new JudgeOutputError("next_message must be a string.");

  if (object.diagnosis !== undefined && object.diagnosis !== null) {
    throw new JudgeOutputError("C2 diagnosis is not supported in this build (SPEC 3).");
  }
  if (object.route_plan !== undefined && object.route_plan !== null) {
    throw new JudgeOutputError("C2 route plans are not supported in this build (SPEC 3).");
  }

  const externalRaw = object.external;
  let external: ExternalWait | null = null;
  if (action === "WAIT_EXTERNAL") {
    const wait = recordOf(externalRaw);
    exactKeys(wait, ["missing", "attempted", "why_no_other_work", "resume_when"]);
    const missing = nonEmpty(wait.missing, "external.missing");
    const why = nonEmpty(wait.why_no_other_work, "external.why_no_other_work");
    const resume = nonEmpty(wait.resume_when, "external.resume_when");
    if (!Array.isArray(wait.attempted) || wait.attempted.length === 0) {
      throw new JudgeOutputError("WAIT_EXTERNAL requires at least one attempted route.");
    }
    const attempted = wait.attempted.map((entry, index) => nonEmpty(entry, `external.attempted[${index}]`));
    external = { missing, attempted, why_no_other_work: why, resume_when: resume };
    if (nextMessage !== "") throw new JudgeOutputError("Only CONTINUE may have a nonempty next_message.");
    if (ids.length === 0) throw new JudgeOutputError("WAIT_EXTERNAL requires evidence IDs.");
    if (snapshot.evidence_complete === false) {
      throw new JudgeOutputError("Incomplete evidence requires CONTINUE to gather concise proof.");
    }
    independentEvidence(ids, snapshot);
  } else if (externalRaw !== null) {
    throw new JudgeOutputError("Only WAIT_EXTERNAL may include external.");
  }

  if (action === "CONTINUE") {
    if (nextMessage.trim().length === 0) throw new JudgeOutputError("CONTINUE requires a nonempty next_message.");
  } else if (nextMessage !== "") {
    throw new JudgeOutputError("Only CONTINUE may have a nonempty next_message.");
  }

  if (action === "DONE") {
    if (ids.length === 0) throw new JudgeOutputError("DONE requires evidence IDs.");
    if (snapshot.evidence_complete === false) {
      throw new JudgeOutputError("Incomplete evidence requires CONTINUE to gather concise proof.");
    }
    independentEvidence(ids, snapshot);
  }

  return { action, reason, evidence_ids: ids, next_message: nextMessage, external };
}

export function decisionSummary(decision: Decision): DecisionSummary {
  return { action: decision.action, reason: decision.reason };
}

export interface Judge {
  decide(snapshot: EvidenceSnapshot, signal?: AbortSignal): Promise<unknown>;
}

export class FixtureJudge implements Judge {
  private index = 0;
  constructor(private readonly decisions: unknown | unknown[]) {}

  async decide(): Promise<unknown> {
    const list = Array.isArray(this.decisions) ? this.decisions : [this.decisions];
    if (this.index >= list.length) throw new JudgeOutputError("Fixture judge has no remaining decision.");
    return structuredClone(list[this.index++]);
  }
}

export class UnavailableJudge implements Judge {
  async decide(): Promise<unknown> {
    throw new JudgeOutputError("No judge is configured for this host.");
  }
}
