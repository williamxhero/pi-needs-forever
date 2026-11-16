import test from "node:test";
import assert from "node:assert/strict";
import { EvidenceBuilder } from "../src/evidence.js";
import type { EntryReader } from "../src/evidence.js";
import type { EntryId } from "@earendil-works/pi-durable";
import type { TaskContract } from "../src/types.js";

const task: TaskContract = {
  schema_version: 1,
  task_id: "task-1",
  workspace: "/workspace",
  goal: "goal",
  acceptance: [{ id: "A1", text: "done" }],
  authorization: "local only",
  c2: { mode: "legacy" },
  limits: { max_worker_turns: null, max_minutes: null },
};

function reader(entries: unknown[]): EntryReader {
  return {
    async entries() {
      return { items: entries, next: undefined } as never;
    },
  };
}

function assistant(text: string, toolCall?: { id: string; name: string; args: Record<string, unknown> }) {
  return {
    id: 1,
    conversationId: "conversation-1",
    kind: "pi.assistant",
    model: [{
      role: "assistant",
      content: [
        { type: "text", text },
        ...(toolCall ? [{ type: "toolCall", id: toolCall.id, name: toolCall.name, arguments: toolCall.args }] : []),
      ],
    }],
  };
}

function toolResult(toolCallId: string, toolName: string, content: string, isError = false) {
  return {
    id: 2,
    conversationId: "conversation-1",
    kind: "pi.tool-result",
    model: [{
      role: "toolResult",
      toolCallId,
      toolName,
      content: [{ type: "text", text: content }],
      isError,
      timestamp: Date.now(),
    }],
  };
}

test("EvidenceBuilder maps tool results to evidence and keeps assistant text as context", async () => {
  const builder = new EvidenceBuilder();
  const snapshot = await builder.build({
    reader: reader([assistant("I am done.", { id: "call-1", name: "bash", args: { command: "echo ok" } }), toolResult("call-1", "bash", "ok")]),
    conversationId: "conversation-1",
    task,
    taskVersion: 1,
    roundId: "round-1",
    run: { first: 1 as EntryId, answer: 2 as EntryId, last: 2 as EntryId },
    context: {} as never,
  });
  assert.equal(snapshot.evidence.length, 1);
  assert.equal(snapshot.evidence[0]?.id, "2");
  assert.equal(snapshot.evidence[0]?.type, "functionCallOutput");
  assert.equal(snapshot.evidence[0]?.source?.event_id, "2");
  assert.match(snapshot.worker_message ?? "", /I am done/);
  assert.equal(snapshot.evidence_complete, true);
});

test("EvidenceBuilder redacts credential-shaped tool output", async () => {
  const builder = new EvidenceBuilder();
  const snapshot = await builder.build({
    reader: reader([assistant("checking"), toolResult("call-1", "bash", "token sk-abcdefghijklmnopqrstuvwx")]),
    conversationId: "conversation-1",
    task,
    taskVersion: 1,
    roundId: "round-1",
    run: { first: 1 as EntryId, answer: 2 as EntryId, last: 2 as EntryId },
    context: {} as never,
  });
  assert.match(JSON.stringify(snapshot.evidence[0]?.value), /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(snapshot.evidence[0]?.value), /sk-abcdefghijklmnopqrstuvwx/);
});

test("EvidenceBuilder marks oversized tool output as incomplete", async () => {
  const builder = new EvidenceBuilder();
  const snapshot = await builder.build({
    reader: reader([assistant("checking"), toolResult("call-1", "bash", "x".repeat(7_000))]),
    conversationId: "conversation-1",
    task,
    taskVersion: 1,
    roundId: "round-1",
    run: { first: 1 as EntryId, answer: 2 as EntryId, last: 2 as EntryId },
    context: {} as never,
  });
  assert.equal(snapshot.evidence_complete, false);
  assert.equal(snapshot.evidence[0]?.complete, false);
  assert.ok(snapshot.omissions.some((entry) => /truncated/i.test(entry)));
});
