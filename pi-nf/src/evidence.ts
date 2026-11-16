import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type {
  Cursor,
  EntryId,
  EntryQuery,
  EntryRecord,
  Page,
} from "@earendil-works/pi-durable";
import type { ControlDoc } from "./docs.js";
import { redact } from "./redact.js";
import type { TaskContract } from "./types.js";
import type { C2Context } from "./routes.js";

export type SnapshotEvidence = {
  id: string;
  type: string;
  value: JsonValue;
  complete?: boolean;
  source?: {
    event_id: string;
    observed_at?: string;
    thread_id?: string;
    turn_id?: string;
    item_id?: string;
  };
};

export type EvidenceSnapshot = {
  snapshot_id: string;
  task_id: string;
  task_version: number;
  worker_thread_id: string;
  worker_turn_id: string;
  task: TaskContract;
  evidence: SnapshotEvidence[];
  worker_message?: string;
  evidence_complete: boolean;
  omissions: string[];
  recent_instructions?: JsonValue[];
  recent_verification?: JsonValue;
  repeated_failure?: JsonValue;
  c2?: C2Context;
};

export type EntryReader = {
  entries(
    query: Omit<EntryQuery, "conversationId">,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<Page<EntryRecord, Cursor>>;
};

export type EvidenceRun = {
  first: EntryId;
  answer: EntryId;
  last: EntryId;
};

export type BuildEvidenceInput = {
  reader: EntryReader;
  conversationId: string;
  task: TaskContract;
  taskVersion: number;
  roundId: string;
  run: EvidenceRun;
  control?: ControlDoc;
  context: Context;
};

export class EvidenceBudgetError extends Error {
  override name = "EvidenceBudgetError";
}

const BUDGET = 24_000;
const RESERVE = 1_000;
const MAX_TOOL_TEXT = 6_000;
const MAX_WORKER_MESSAGE = 2_000;

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .filter((part): part is { type: string; text: string } => {
        return !!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string";
      })
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

function cloneJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(redact(value))) as JsonValue;
}

function truncatedText(value: string, limit: number): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`, truncated: true };
}

export class EvidenceBuilder {
  async build(input: BuildEvidenceInput): Promise<EvidenceSnapshot> {
    const task = cloneJson(input.task) as TaskContract;
    const snapshot: EvidenceSnapshot = {
      snapshot_id: randomUUID(),
      task_id: input.task.task_id,
      task_version: input.taskVersion,
      worker_thread_id: input.conversationId,
      worker_turn_id: input.roundId,
      task,
      evidence: [],
      evidence_complete: true,
      omissions: [],
    };
    if (input.control?.last_decision) {
      snapshot.recent_instructions = [cloneJson(input.control.last_decision)];
    }
    if (JSON.stringify(snapshot).length > BUDGET - RESERVE) {
      throw new EvidenceBudgetError("The contract alone exceeds the 24k judge budget; provide a concise contract.");
    }

    const entries: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await input.reader.entries(
        { minEntryId: input.run.first, maxEntryId: input.run.last, order: "ascending" },
        500,
        cursor,
        input.context,
      );
      entries.push(...page.items);
      cursor = page.next;
    } while (cursor);

    const toolCalls = new Map<string, { name: string; args: JsonValue }>();
    for (const entry of entries) {
      const message = entry.model?.[0];
      if (!message || message.role !== "assistant") continue;
      for (const block of message.content) {
        if (block.type === "toolCall") {
          toolCalls.set(block.id, { name: block.name, args: cloneJson(block.arguments) });
        }
      }
    }

    let workerMessage: string | undefined;
    for (const entry of entries) {
      const message = entry.model?.[0];
      if (!message) continue;
      if (message.role === "assistant") {
        const text = textOf(message.content);
        if (text.trim()) workerMessage = text;
        continue;
      }
      if (message.role !== "toolResult") continue;
      const call = toolCalls.get(message.toolCallId);
      const rawText = textOf(message.content);
      const text = truncatedText(rawText, MAX_TOOL_TEXT);
      if (text.truncated) {
        snapshot.evidence_complete = false;
        snapshot.omissions.push(`Tool result ${String(entry.id)} was truncated to ${MAX_TOOL_TEXT} characters; gather concise proof.`);
      }
      const candidate: SnapshotEvidence = {
        id: String(entry.id),
        type: message.toolName === "write" || message.toolName === "edit" ? "fileChange" : "functionCallOutput",
        value: cloneJson({
          tool_name: message.toolName,
          tool_call_id: message.toolCallId,
          arguments: call?.args ?? null,
          is_error: message.isError,
          content: text.text,
          details: message.details ?? null,
        }),
        complete: !text.truncated,
        source: {
          event_id: String(entry.id),
          thread_id: input.conversationId,
          turn_id: input.roundId,
          item_id: message.toolCallId,
        },
      };
      const projected = JSON.stringify({ ...snapshot, evidence: [...snapshot.evidence, candidate] });
      if (projected.length > BUDGET) {
        snapshot.evidence_complete = false;
        snapshot.omissions.push(`Evidence ${candidate.id} omitted to stay within the 24k budget.`);
        continue;
      }
      snapshot.evidence.push(candidate);
    }

    if (workerMessage) {
      const message = truncatedText(workerMessage, MAX_WORKER_MESSAGE);
      snapshot.worker_message = message.text;
      if (message.truncated) {
        snapshot.evidence_complete = false;
        snapshot.omissions.push("Worker message truncated; it is context only and cannot be completion evidence.");
      }
    }
    if (snapshot.omissions.length > 0) snapshot.evidence_complete = false;
    if (JSON.stringify(snapshot).length > BUDGET) {
      throw new EvidenceBudgetError("The judge snapshot exceeded 24k after construction.");
    }
    return snapshot;
  }
}
