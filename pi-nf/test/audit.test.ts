import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { auditDirectory, readAudit, writeAudit } from "../src/audit.js";
import { Host } from "../src/host.js";
import { FixtureJudge, type Judge } from "../src/judge.js";

function models(responses: AssistantMessage[]): ReturnType<typeof createModels> {
  const collection = createModels();
  const faux = fauxProvider({ models: [{ id: "faux-model", name: "Faux Model" }] });
  collection.setProvider(faux.provider);
  faux.setResponses(responses);
  return collection;
}

function contract(workspace: string, limits: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: 1,
    task_id: "audit-task",
    workspace,
    goal: "audit projection",
    acceptance: [{ id: "A1", text: "projection matches committed state" }],
    authorization: "local only",
    c2: { mode: "legacy" },
    limits,
  };
}

async function runTask(
  workspace: string,
  db: string,
  judge: Judge,
  limits: Record<string, unknown>,
  responses: AssistantMessage[] = [],
): Promise<void> {
  const host = await Host.open({
    storage: await openNodeSqliteStorage(db),
    models: models(responses.length ? responses : [fauxAssistantMessage("ok")]),
    model: { provider: "faux", modelId: "faux-model" },
    contract: contract(workspace, limits),
    db_path: db,
    judge,
  });
  try {
    await host.start();
    await host.waitForIdle();
  } finally {
    await host.close();
  }
}

test("audit projects a DONE round without inventing a delivery", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-audit-done-"));
  const db = join(workspace, "state.sqlite");
  try {
    let calls = 0;
    const judge: Judge = {
      async decide(snapshot) {
        calls += 1;
        if (calls === 1) {
          return { action: "CONTINUE", reason: "no evidence yet", evidence_ids: [], next_message: "run a command", external: null };
        }
        const evidence = snapshot.evidence[0];
        assert.ok(evidence);
        return { action: "DONE", reason: "tool evidence", evidence_ids: [evidence.id], next_message: "", external: null };
      },
    };
    await runTask(workspace, db, judge, { max_worker_turns: null, max_minutes: null }, [
      fauxAssistantMessage("I am done."),
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo evidence" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Finished with evidence."),
    ]);

    const audit = await readAudit(db);
    assert.equal(audit.schema_version, 1);
    assert.equal(audit.engine, "pi-nf");
    assert.equal(audit.task_id, "audit-task");
    assert.equal(audit.contract.goal, "audit projection");
    assert.equal(audit.control.status, "DONE");
    assert.equal(audit.rounds.length, 2);
    assert.equal(audit.rounds[0]?.decision?.action, "CONTINUE");
    const round = audit.rounds[1]!;
    assert.equal(round.status, "decided");
    assert.equal(round.decision?.action, "DONE");
    assert.equal(round.delivery, null);
    assert.equal(round.verification, null);
    assert.ok(audit.events.some((event) => event.type === "nf.judge_started"));
    assert.ok(audit.events.some((event) => event.type === "nf.decision"));

    const before = JSON.stringify(audit.control);
    const again = await readAudit(db);
    assert.equal(JSON.stringify(again.control), before, "the audit read must not mutate committed state");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("audit records a delivered CONTINUE direction and the limit round", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-audit-continue-"));
  const db = join(workspace, "state.sqlite");
  try {
    await runTask(workspace, db, new FixtureJudge([
      { action: "CONTINUE", reason: "more work", evidence_ids: [], next_message: "continue please", external: null },
      { action: "CONTINUE", reason: "still more", evidence_ids: [], next_message: "continue again", external: null },
    ]), { max_worker_turns: 2, max_minutes: null }, [
      fauxAssistantMessage("ok"),
      fauxAssistantMessage("ok"),
      fauxAssistantMessage("ok"),
    ]);

    const audit = await readAudit(db);
    assert.equal(audit.control.status, "PAUSED");
    assert.equal(audit.control.pause_reason, "user_limit");
    assert.equal(audit.rounds.length, 2);
    const [first, second] = audit.rounds;
    assert.equal(first?.decision?.action, "CONTINUE");
    assert.equal(first?.delivery?.message, "continue please");
    assert.ok(first?.delivery?.submission_id, "a CONTINUE direction has a submission id");
    assert.equal(first?.delivery?.submission_status, "done");
    assert.equal(first?.delivery?.delivered, true);
    assert.equal(second?.decision?.action, "CONTINUE");
    assert.equal(second?.delivery, null, "a limit stop never claims a delivery");
    assert.ok(audit.events.some((event) => event.type === "nf.limit_reached"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("writeAudit publishes an atomic projection inside the task workspace", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-audit-write-"));
  const db = join(workspace, "state.sqlite");
  try {
    let calls = 0;
    const judge: Judge = {
      async decide(snapshot) {
        calls += 1;
        if (calls === 1) {
          return { action: "CONTINUE", reason: "no evidence yet", evidence_ids: [], next_message: "run a command", external: null };
        }
        const evidence = snapshot.evidence[0];
        assert.ok(evidence);
        return { action: "DONE", reason: "tool evidence", evidence_ids: [evidence.id], next_message: "", external: null };
      },
    };
    await runTask(workspace, db, judge, { max_worker_turns: null, max_minutes: null }, [
      fauxAssistantMessage("I am done."),
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo evidence" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Finished with evidence."),
    ]);

    const result = await writeAudit(db);
    const expected = join(auditDirectory(workspace, "audit-task"), "audit.json");
    assert.equal(result.path, expected);
    assert.ok(existsSync(expected));
    const published = JSON.parse(readFileSync(expected, "utf8")) as { engine: string; task_id: string; rounds: unknown[] };
    assert.equal(published.engine, "pi-nf");
    assert.equal(published.task_id, "audit-task");
    assert.equal(published.rounds.length, 2);

    // The CLI mirror rewrites the same path; an atomic refresh must replace it.
    const refreshed = await writeAudit(db);
    assert.equal(refreshed.path, expected);
    assert.equal(JSON.parse(readFileSync(expected, "utf8")).task_id, "audit-task");

    const custom = join(workspace, "custom-nfg");
    const customResult = await writeAudit(db, { root: custom });
    assert.equal(customResult.path, join(custom, "audit-task", "audit.json"));
    assert.ok(existsSync(customResult.path));

    const output = execFileSync(process.execPath, ["dist/src/cli.js", "audit", "--db", db, "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const printed = JSON.parse(output) as { engine: string; task_id: string };
    assert.equal(printed.engine, "pi-nf");
    assert.equal(printed.task_id, "audit-task");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
