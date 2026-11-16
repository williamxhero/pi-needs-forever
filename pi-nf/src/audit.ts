import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Cursor, EntryRecord, SubmissionId } from "@earendil-works/pi-durable";
import { Harness, ROOT_CONVERSATION_ID, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  NfContract,
  NfControl,
  NfDirection,
  NfEvent,
  NfRoute,
  NfRound,
  NfUsage,
  NfVerify,
  type DirectionData,
  type NfEventData,
} from "./docs.js";
import type { Decision } from "./judge.js";
import type {
  ControlPhase,
  ControlStatus,
  DecisionSummary,
  DeliveryState,
  TaskContract,
  VerificationStatus,
} from "./types.js";

/**
 * Read-only audit projection for a display host such as NFG.
 *
 * The authoritative state remains the pi-durable SQLite database. This
 * projection is computed from committed documents and entries only; it never
 * writes task state and is never read back by pi-nf.
 */
export type NfAudit = {
  schema_version: 1;
  engine: "pi-nf";
  generated_at: string;
  task_id: string;
  task_version: number;
  contract: TaskContract;
  control: {
    status: ControlStatus;
    phase: ControlPhase;
    input_epoch: number;
    worker_turns: number;
    active_seconds: number;
    last_round_id: string | null;
    last_decision: DecisionSummary | null;
    delivery: DeliveryState | null;
    last_error: string | null;
    pause_reason: string | null;
    limit_reason: string | null;
    updated_at: string;
  };
  verification: VerificationStatus;
  usage: {
    judge: {
      provider: string;
      model: string;
      input: number;
      output: number;
      cost: number;
      attempts: number;
    } | null;
  };
  route: {
    mode: string;
    selected_route_id: string | null;
    candidate_count: number;
    attempts: number;
    last_outcome: string | null;
  };
  rounds: NfAuditRound[];
  events: NfAuditEvent[];
};

export type NfAuditEvent = NfEventData;

export type NfAuditDelivery = {
  /** pi-nf's durable delivery stage for this direction. */
  stage: DeliveryState["stage"];
  submission_id: string | null;
  /** pi-durable submission status: queued, placed, done or unanswered. */
  submission_status: string | null;
  /** True only when the submission was placed (A started) or answered. */
  delivered: boolean;
  /** When pi-nf committed the direction and its submission. */
  submitted_at: string;
  message: string;
  route_id: string | null;
  plan_id: string | null;
};

export type NfAuditRound = {
  round_id: string;
  started_at: string;
  updated_at: string;
  status: "open" | "decided" | "interrupted" | "superseded";
  snapshot_id: string | null;
  evidence_count: number;
  decision: Decision | null;
  delivery: NfAuditDelivery | null;
  verification: { passed: boolean; result: unknown; at: string } | null;
  errors: { type: string; at: string; message: string | null }[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function timeValue(value: unknown): string {
  return typeof value === "string" && value.length ? value : new Date(0).toISOString();
}

function asDecision(value: unknown): Decision | null {
  const record = asRecord(value);
  const action = stringValue(record?.action);
  if (!record || (action !== "CONTINUE" && action !== "DONE" && action !== "WAIT_EXTERNAL")) return null;
  return record as unknown as Decision;
}

function roundFor(rounds: Map<string, NfAuditRound>, roundId: string, at: string): NfAuditRound {
  const existing = rounds.get(roundId);
  if (existing) return existing;
  const round: NfAuditRound = {
    round_id: roundId,
    started_at: at,
    updated_at: at,
    status: "open",
    snapshot_id: null,
    evidence_count: 0,
    decision: null,
    delivery: null,
    verification: null,
    errors: [],
  };
  rounds.set(roundId, round);
  return round;
}

async function readEntries(harness: Harness, context: Context): Promise<EntryRecord[]> {
  const conversation = await harness.conversation(ROOT_CONVERSATION_ID, context);
  if (!conversation) return [];
  const entries: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({ order: "ascending" }, 500, cursor, context);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return entries;
}

export async function readAudit(dbPath: string, context: Context = BACKGROUND_CONTEXT): Promise<NfAudit> {
  if (!existsSync(dbPath)) throw new Error(`pi-nf database does not exist: ${dbPath}`);
  const storage = await openNodeSqliteStorage(dbPath);
  const harness = await Harness.open(
    storage,
    { models: createModels(), registry: createRegistry(), readOnly: true },
    context,
  );
  try {
    const [contract, control, roundDoc, usage, verifyDoc, routeDoc] = await Promise.all([
      harness.snapshot(NfContract, ROOT_CONVERSATION_ID, context),
      harness.snapshot(NfControl, ROOT_CONVERSATION_ID, context),
      harness.snapshot(NfRound, ROOT_CONVERSATION_ID, context),
      harness.snapshot(NfUsage, ROOT_CONVERSATION_ID, context),
      harness.snapshot(NfVerify, ROOT_CONVERSATION_ID, context),
      harness.snapshot(NfRoute, ROOT_CONVERSATION_ID, context),
    ]);
    if (!contract?.task || contract.status !== "ready") throw new Error("pi-nf task has no ready contract.");
    if (!control) throw new Error("pi-nf task has no control document.");

    const entries = await readEntries(harness, context);
    const events: NfAuditEvent[] = [];
    const directions: DirectionData[] = [];
    for (const entry of entries) {
      if (NfEvent.is(entry)) events.push(entry.data);
      else if (NfDirection.is(entry)) directions.push(entry.data);
    }
    events.sort((left, right) => timeValue(left.at).localeCompare(timeValue(right.at)));

    const rounds = new Map<string, NfAuditRound>();
    for (const event of events) {
      const details = asRecord(event.details);
      const roundId = stringValue(details?.round_id);
      if (!roundId) continue;
      const at = timeValue(event.at);
      const round = roundFor(rounds, roundId, at);
      round.updated_at = round.updated_at > at ? round.updated_at : at;
      switch (event.type) {
        case "nf.judge_started": {
          round.snapshot_id = stringValue(details?.snapshot_id) ?? round.snapshot_id;
          if (typeof details?.evidence_count === "number") round.evidence_count = details.evidence_count;
          break;
        }
        case "nf.decision": {
          const decision = asDecision(details?.decision);
          if (decision) round.decision = decision;
          round.snapshot_id = stringValue(details?.snapshot_id) ?? round.snapshot_id;
          const delivery = asRecord(details?.delivery);
          if (delivery) {
            round.delivery = {
              stage: "submitted",
              submission_id: stringValue(delivery.submission_id),
              submission_status: null,
              delivered: false,
              submitted_at: at,
              message: decision?.next_message ?? "",
              route_id: stringValue(asRecord(decision?.route_plan)?.selected_route_id),
              plan_id: stringValue(asRecord(decision?.route_plan)?.plan_id),
            };
          }
          const verification = details?.verification;
          if (verification !== undefined && verification !== null && !round.verification) {
            round.verification = { passed: true, result: verification, at };
          }
          round.status = "decided";
          break;
        }
        case "nf.verification": {
          round.verification = { passed: details?.passed === true, result: details?.result ?? null, at };
          break;
        }
        case "nf.verification_failed": {
          round.verification = { passed: false, result: details?.result ?? null, at };
          break;
        }
        case "nf.round_superseded": {
          round.status = "superseded";
          break;
        }
        case "nf.judge_retry": {
          round.errors.push({ type: event.type, at, message: stringValue(details?.error) });
          break;
        }
        case "nf.judge_rejected":
        case "nf.judge_interrupted":
        case "nf.snapshot_failed":
        case "nf.verification_interrupted":
        case "nf.verification_missing_baseline": {
          round.status = "interrupted";
          round.errors.push({
            type: event.type,
            at,
            message: stringValue(details?.error) ?? stringValue(details?.reason),
          });
          break;
        }
        default:
          break;
      }
    }

    for (const direction of directions) {
      const roundId = stringValue(direction.round_id);
      if (!roundId) continue;
      const at = timeValue(direction.created_at);
      const round = roundFor(rounds, roundId, at);
      round.updated_at = round.updated_at > at ? round.updated_at : at;
      const decision = asDecision(direction.decision);
      if (decision && !round.decision) round.decision = decision;
      const previous = round.delivery;
      round.delivery = {
        stage: previous?.stage ?? "submitted",
        submission_id: previous?.submission_id ?? null,
        submission_status: null,
        delivered: false,
        submitted_at: at,
        message: decision?.next_message ?? previous?.message ?? "",
        route_id: direction.route_id ?? previous?.route_id ?? null,
        plan_id: direction.plan_id ?? previous?.plan_id ?? null,
      };
    }

    // The latest round document is the only durable copy of a decision that
    // ended in a user limit, because that commit appends nf.limit_reached
    // instead of nf.decision.
    if (roundDoc?.round_id) {
      const at = timeValue(roundDoc.updated_at);
      const round = roundFor(rounds, roundDoc.round_id, timeValue(roundDoc.created_at) || at);
      round.updated_at = round.updated_at > at ? round.updated_at : at;
      const decision = asDecision(roundDoc.decision);
      if (decision && !round.decision) round.decision = decision;
      round.snapshot_id = round.snapshot_id ?? (stringValue(roundDoc.snapshot_id) ?? null);
      round.evidence_count = Math.max(round.evidence_count, typeof roundDoc.evidence_count === "number" ? roundDoc.evidence_count : 0);
      if (roundDoc.status === "interrupted") round.status = "interrupted";
      else if (roundDoc.status === "superseded") round.status = "superseded";
      else if (decision) round.status = "decided";
    }

    const submissionIds = new Set<string>();
    for (const round of rounds.values()) {
      const submissionId = round.delivery?.submission_id;
      if (submissionId) submissionIds.add(submissionId);
    }
    const submissionStatuses = new Map<string, string>();
    for (const submissionId of submissionIds) {
      const numeric = Number(submissionId);
      if (!Number.isFinite(numeric)) continue;
      try {
        const submission = await harness.submission(numeric as SubmissionId, context);
        if (submission) submissionStatuses.set(submissionId, (await submission.status(context)).status);
      } catch {
        // A missing or unreadable submission is reported as an unknown delivery.
      }
    }
    for (const round of rounds.values()) {
      const delivery = round.delivery;
      if (!delivery) continue;
      delivery.submission_status = delivery.submission_id ? submissionStatuses.get(delivery.submission_id) ?? null : null;
      delivery.delivered = delivery.submission_status === "placed" || delivery.submission_status === "done";
    }

    const ordered = [...rounds.values()].sort((left, right) => left.started_at.localeCompare(right.started_at));
    const lastRound = ordered.at(-1);
    const configured = Boolean(contract.task.verify);
    const lastResult = (verifyDoc?.last_result ?? null) as { passed?: unknown } | null;
    const plan = asRecord(lastRound?.decision?.route_plan);
    const candidateCount = Array.isArray(plan?.candidates) ? plan.candidates.length : 0;
    const ledger = routeDoc?.ledger ?? [];

    return {
      schema_version: 1,
      engine: "pi-nf",
      generated_at: new Date().toISOString(),
      task_id: contract.task.task_id,
      task_version: control.task_version,
      contract: contract.task,
      control: {
        status: control.status as ControlStatus,
        phase: control.phase as ControlPhase,
        input_epoch: control.input_epoch,
        worker_turns: control.worker_turns,
        active_seconds: control.active_seconds,
        last_round_id: control.last_round_id,
        last_decision: control.last_decision,
        delivery: control.delivery,
        last_error: control.last_error,
        pause_reason: control.pause_reason,
        limit_reason: control.limit_reason,
        updated_at: control.updated_at,
      },
      verification: {
        configured,
        baseline_count: verifyDoc?.baseline?.length ?? 0,
        state: !configured
          ? "not_configured"
          : verifyDoc?.baseline === null || verifyDoc?.baseline === undefined
            ? "failed"
            : lastResult && typeof lastResult === "object" && "error" in lastResult
              ? "failed"
              : lastResult?.passed === true
                ? "passed"
                : lastResult?.passed === false
                  ? "failed"
                  : "ready",
        last_result: verifyDoc?.last_result ?? null,
      },
      usage: { judge: usage?.judge ?? null },
      route: {
        mode: contract.task.c2?.mode ?? "enforce",
        selected_route_id: control.last_route_id ?? routeDoc?.execution?.route_id ?? null,
        candidate_count: candidateCount,
        attempts: ledger.length,
        last_outcome: ledger.at(-1)?.outcome ?? null,
      },
      rounds: ordered,
      events,
    };
  } finally {
    await harness.close(context);
  }
}

/** `<workspace>/.pi-nf/<task_id>` — the display projection, not task state. */
export function auditDirectory(workspace: string, taskId: string): string {
  if (!/^[\w.-]+$/.test(taskId) || taskId === "." || taskId === "..") throw new Error("Invalid pi-nf task id.");
  return resolve(workspace, ".pi-nf", taskId);
}

export type WriteAuditOptions = {
  /** Override the default `<workspace>/.pi-nf` projection root. */
  root?: string;
  context?: Context;
};

/**
 * Atomically write the read-only audit projection into the task workspace so a
 * file-based display host can discover pi-nf tasks without another process.
 */
export async function writeAudit(dbPath: string, options: WriteAuditOptions = {}): Promise<{ path: string; audit: NfAudit }> {
  const context = options.context ?? BACKGROUND_CONTEXT;
  const audit = await readAudit(dbPath, context);
  const directory = options.root
    ? resolve(options.root, audit.task_id)
    : auditDirectory(audit.contract.workspace, audit.task_id);
  const path = resolve(directory, "audit.json");
  mkdirSync(directory, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
  return { path, audit };
}
