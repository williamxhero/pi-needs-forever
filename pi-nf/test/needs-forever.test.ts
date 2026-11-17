import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNeedsForever,
  createNeedsForeverExtension,
  formatHelp,
  parseNeedsForeverCommand,
  type HandoffLaunch,
  type HandoffRuntime,
  type IssueSnapshot,
  type NeedsForever,
  DetachedCliRuntime,
} from "../src/needs-forever.js";
import registerNeedsForever from "../src/extension.js";
import { mkdirSync as mkdir, readFileSync as readFile } from "node:fs";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { auditDirectory, writeAudit } from "../src/audit.js";
import { Host } from "../src/host.js";
import { FixtureJudge } from "../src/judge.js";

class FakeRuntime implements HandoffRuntime {
  launches: HandoffLaunch[] = [];
  terminated: (number | null)[] = [];
  alive = true;
  pid: number | null = 4242;

  async launch(input: HandoffLaunch): Promise<{ pid: number | null }> {
    this.launches.push(input);
    this.alive = true;
    return { pid: this.pid };
  }

  isAlive(pid: number | null): boolean {
    return this.alive && pid === this.pid;
  }

  terminate(pid: number | null): void {
    this.terminated.push(pid);
  }
}

function fixture(options: { verify?: boolean; contract?: Record<string, unknown>; probeTaskId?: string; probe?: () => Promise<{ task_id: string; status?: string }> } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-needs-"));
  const home = mkdtempSync(join(tmpdir(), "pi-nf-home-"));
  const issue: IssueSnapshot = {
    repo: "owner/repo",
    number: 454,
    title: "完成总需求 454",
    body: [
      "## Acceptance",
      "- [ ] 构建成功",
      "- [ ] 测试通过",
    ].join("\n"),
    url: "https://github.com/owner/repo/issues/454",
    state: "OPEN",
  };
  const verify = options.verify !== false;
  writeFileSync(join(workspace, ".needs-forever.json"), JSON.stringify({
    workspace: ".",
    authorization: "Only modify this workspace.",
    ...(verify ? { verify: { argv: [process.execPath, "verify.mjs"], timeout_seconds: 30, protected_files: [] } } : {}),
    c2: { mode: "enforce" },
    limits: { max_worker_turns: null, max_minutes: null },
  }));
  if (options.contract) writeFileSync(join(workspace, "reviewed.json"), JSON.stringify(options.contract));
  const runtime = new FakeRuntime();
  const needs = createNeedsForever({
    cwd: workspace,
    home,
    issueReader: async () => issue,
    runtime,
    probe: options.probe ?? (async () => ({ task_id: options.probeTaskId ?? "issue-454", status: "ACTIVE" })),
    now: () => new Date("2026-11-16T08:00:00.000Z"),
    sleep: async () => {},
    readyTimeoutMs: 100,
  });
  return {
    workspace,
    home,
    issue,
    runtime,
    needs,
    cleanup: () => {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("preview resolves a project config and issue checklist without side effects", async () => {
  const data = fixture();
  try {
    const preview = await data.needs.preview({ repo: "owner/repo", issue: 454, cwd: data.workspace });
    assert.equal(preview.requestKey, "owner/repo#454");
    assert.equal(preview.source, "project");
    assert.equal(preview.gaps.length, 0);
    assert.equal(preview.contract?.task_id, "issue-454");
    assert.deepEqual(preview.contract?.acceptance, [
      { id: "A1", text: "构建成功" },
      { id: "A2", text: "测试通过" },
    ]);
    assert.equal(preview.contract?.workspace, data.workspace);
    assert.ok(preview.contractHash);
    assert.equal(data.runtime.launches.length, 0);
    assert.equal(existsSync(join(data.home, "tasks")), false, "preview does not create state");
  } finally {
    data.cleanup();
  }
});

test("missing verifier is a gap and --yes cannot bypass it", async () => {
  const data = fixture({ verify: false });
  try {
    const preview = await data.needs.preview({ repo: "owner/repo", issue: 454, cwd: data.workspace });
    assert.ok(preview.gaps.some((gap) => gap.field === "verify"));
    const result = await data.needs.start({ repo: "owner/repo", issue: 454, cwd: data.workspace, yes: true });
    assert.equal(result.kind, "rejected");
    assert.equal(result.kind === "rejected" ? result.reason : null, "gaps");
    assert.equal(data.runtime.launches.length, 0);
  } finally {
    data.cleanup();
  }
});

test("start requires confirmation, starts one detached handoff, and reuses a live receipt", async () => {
  const data = fixture();
  try {
    const refused = await data.needs.start({ repo: "owner/repo", issue: 454, cwd: data.workspace });
    assert.equal(refused.kind, "rejected");
    assert.equal(refused.kind === "rejected" ? refused.reason : null, "confirmation_required");
    assert.equal(data.runtime.launches.length, 0);

    const started = await data.needs.start({ repo: "owner/repo", issue: 454, cwd: data.workspace, yes: true });
    assert.equal(started.kind, "started");
    assert.equal(data.runtime.launches.length, 1);
    assert.equal(data.runtime.launches[0]?.mode, "start");
    if (started.kind !== "started") throw new Error("expected started");
    assert.equal(started.receipt.taskId, "issue-454");
    assert.ok(started.receipt.contractHash);
    assert.ok(started.receipt.receiptPath.startsWith(data.home));
    assert.ok(started.receipt.contractPath.startsWith(data.home));
    assert.ok(started.receipt.stateDb.startsWith(data.home));
    assert.ok(started.receipt.nfgPath.includes(".pi-nf"));
    assert.ok(existsSync(started.receipt.contractPath));
    assert.ok(existsSync(started.receipt.receiptPath));
    assert.equal(JSON.parse(readFileSync(started.receipt.contractPath, "utf8")).task_id, "issue-454");

    const again = await data.needs.start({ repo: "owner/repo", issue: 454, cwd: data.workspace, yes: true });
    assert.equal(again.kind, "existing");
    assert.equal(data.runtime.launches.length, 1);
    const inspected = await data.needs.inspect({ repo: "owner/repo", issue: 454, cwd: data.workspace });
    assert.equal(inspected?.status, "running");
  } finally {
    data.cleanup();
  }
});

test("a dead receipt conflicts until explicit restart and then recovers", async () => {
  const data = fixture();
  try {
    const started = await data.needs.start({ repo: "owner/repo", issue: 454, cwd: data.workspace, yes: true });
    assert.equal(started.kind, "started");
    data.runtime.alive = false;
    const conflict = await data.needs.start({ repo: "owner/repo", issue: 454, cwd: data.workspace, yes: true });
    assert.equal(conflict.kind, "conflict");
    assert.match(conflict.kind === "conflict" ? conflict.reason : "", /--restart/);
    assert.equal(data.runtime.launches.length, 1);

    const restarted = await data.needs.start({ repo: "owner/repo", issue: 454, cwd: data.workspace, restart: true });
    assert.equal(restarted.kind, "started");
    assert.equal(data.runtime.launches.length, 2);
    assert.equal(data.runtime.launches[1]?.mode, "recover");
  } finally {
    data.cleanup();
  }
});

test("explicit reviewed contract and issue prose are deterministic sources", async () => {
  const contract = {
    schema_version: 1,
    task_id: "reviewed-454",
    workspace: "",
    goal: "reviewed goal",
    acceptance: [{ id: "A1", text: "reviewed acceptance" }],
    authorization: "reviewed authorization",
    c2: { mode: "legacy" },
    verify: { argv: [process.execPath, "verify.mjs"], timeout_seconds: 30, protected_files: [] },
    limits: { max_worker_turns: 3, max_minutes: null },
  };
  const data = fixture({ contract: { ...contract, workspace: "" }, probeTaskId: "reviewed-454" });
  try {
    const withPath = { ...contract, workspace: data.workspace };
    writeFileSync(join(data.workspace, "reviewed.json"), JSON.stringify(withPath));
    const preview = await data.needs.preview({ repo: "owner/repo", issue: 454, cwd: data.workspace, contractPath: "reviewed.json" });
    assert.equal(preview.source, "explicit");
    assert.equal(preview.contract?.task_id, "reviewed-454");
    assert.equal(preview.gaps.length, 0);
    const started = await data.needs.start({ repo: "owner/repo", issue: 454, cwd: data.workspace, contractPath: "reviewed.json" });
    assert.equal(started.kind, "started");
  } finally {
    data.cleanup();
  }
});

test("command parser supports Chinese text, flags, status and help", () => {
  const preview = parseNeedsForeverCommand("完成总需求 454");
  assert.equal(preview.mode, "preview");
  assert.equal(preview.request.issue, 454);
  const dry = parseNeedsForeverCommand("454 --dry-run --repo owner/repo");
  assert.equal(dry.mode, "preview");
  assert.equal(dry.request.repo, "owner/repo");
  const yes = parseNeedsForeverCommand("454 --yes");
  assert.equal(yes.mode, "start");
  assert.equal(yes.request.yes, true);
  const contract = parseNeedsForeverCommand("454 --contract task.json");
  assert.equal(contract.mode, "start");
  assert.equal(contract.request.contractPath, "task.json");
  const status = parseNeedsForeverCommand("status 454");
  assert.equal(status.mode, "status");
  assert.equal(parseNeedsForeverCommand("help").mode, "help");
  assert.match(formatHelp(), /new A session|NEW A session/);
});

test("Pi extension is a thin renderer over NeedsForever", async () => {
  const calls: string[] = [];
  const notices: { message: string; level?: string }[] = [];
  const fake: NeedsForever = {
    async preview(request) {
      calls.push(`preview:${request.issue}:${request.cwd}`);
      return {
        requestKey: "owner/repo#454",
        contract: null,
        draft: {},
        contractHash: null,
        source: "draft",
        gaps: [{ field: "verify", message: "missing verifier" }],
      };
    },
    async start(request) {
      calls.push(`start:${request.issue}:${request.yes}:${request.cwd}`);
      return {
        kind: "rejected",
        preview: {
          requestKey: "owner/repo#454",
          contract: null,
          draft: {},
          contractHash: null,
          source: "draft",
          gaps: [{ field: "verify", message: "missing verifier" }],
        },
        reason: "gaps",
      };
    },
    async inspect(request) {
      calls.push(`inspect:${typeof request === "string" ? request : request.issue}`);
      return null;
    },
  };
  const commands: { name: string; handler: (args: string, ctx: { cwd: string; ui: { notify(message: string, level?: "info" | "warning" | "error"): void } }) => Promise<void> }[] = [];
  const pi = {
    registerCommand(name: string, options: { handler: (args: string, ctx: { cwd: string; ui: { notify(message: string, level?: "info" | "warning" | "error"): void } }) => Promise<void> }) {
      commands.push({ name, handler: options.handler });
    },
  };
  createNeedsForeverExtension(fake)(pi);
  assert.equal(commands[0]?.name, "needs-forever");
  const packageCommands: string[] = [];
  registerNeedsForever({
    registerCommand(name: string) {
      packageCommands.push(name);
    },
  });
  assert.deepEqual(packageCommands, ["needs-forever"]);
  const ctx = { cwd: "C:/work", ui: { notify(message: string, level?: "info" | "warning" | "error") { notices.push({ message, level }); } } };
  await commands[0]!.handler("454", ctx);
  assert.deepEqual(calls, ["preview:454:C:/work"]);
  await commands[0]!.handler("454 --yes", ctx);
  assert.deepEqual(calls, ["preview:454:C:/work", "start:454:true:C:/work"]);
  await commands[0]!.handler("status 454", ctx);
  assert.deepEqual(calls, ["preview:454:C:/work", "start:454:true:C:/work", "inspect:454"]);
  assert.equal(notices.length, 3);
  assert.match(notices[0]!.message, /Needs Forever preview/);
});


test("a failed readiness handshake terminates the child and leaves no receipt", async () => {
  const data = fixture({
    probe: async () => {
      throw new Error("not ready");
    },
  });
  try {
    await assert.rejects(
      data.needs.start({ repo: "owner/repo", issue: 454, cwd: data.workspace, yes: true }),
      /timed out waiting|not ready/i,
    );
    assert.deepEqual(data.runtime.terminated, [4242]);
    assert.equal(existsSync(join(data.home, "handoff", "owner-repo", "454.json")), false);
    assert.equal(existsSync(join(data.home, "tasks", "owner-repo", "454", "contract.json")), false);
  } finally {
    data.cleanup();
  }
});

test("the detached CLI runtime survives its launcher call until explicitly terminated", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-detached-"));
  const marker = join(workspace, "marker");
  const script = join(workspace, "sleeper.mjs");
  writeFileSync(script, `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => process.exit(0));
writeFileSync(${JSON.stringify(marker)}, "up");
setTimeout(() => {}, 5000);
`);
  const runtime = new DetachedCliRuntime({ cliPath: script });
  let pid: number | null = null;
  try {
    const launched = await runtime.launch({
      mode: "start",
      contractPath: join(workspace, "contract.json"),
      dbPath: join(workspace, "state.sqlite"),
      logPath: join(workspace, "run.log"),
      workspace,
    });
    pid = launched.pid;
    assert.ok(pid);
    const deadline = Date.now() + 3000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(existsSync(marker), "detached child wrote its marker");
    assert.equal(runtime.isAlive(pid), true);
    runtime.terminate(pid);
    const stop = Date.now() + 3000;
    while (runtime.isAlive(pid) && Date.now() < stop) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runtime.isAlive(pid), false);
  } finally {
    runtime.terminate(pid);
    await new Promise((resolve) => setTimeout(resolve, 200));
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});


test("the handoff receipt names the same NFG projection a real pi-nf task publishes", async () => {
  const data = fixture();
  const db = join(data.workspace, "state.sqlite");
  try {
    const models = createModels();
    const faux = fauxProvider({ models: [{ id: "faux-model", name: "Faux Model" }] });
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("ok")]);
    const host = await Host.open({
      storage: await openNodeSqliteStorage(db),
      models,
      model: { provider: "faux", modelId: "faux-model" },
      contract: {
        schema_version: 1,
        task_id: "issue-454",
        workspace: data.workspace,
        goal: "fixture goal",
        acceptance: [{ id: "A1", text: "fixture acceptance" }],
        authorization: "fixture authorization",
        c2: { mode: "legacy" },
        limits: { max_worker_turns: null, max_minutes: null },
      },
      db_path: db,
      judge: new FixtureJudge({ action: "WAIT_EXTERNAL", reason: "fixture", evidence_ids: [], next_message: "", external: { missing: "x", attempted: [], why_no_other_work: "y", resume_when: "z" } }),
    });
    try {
      await host.start();
      await host.waitForIdle();
    } finally {
      await host.close();
    }
    const published = await writeAudit(db);
    assert.equal(published.audit.schema_version, 2);
    assert.ok(published.audit.transcript.items.length > 0, "a real task publishes a transcript");

    const started = await data.needs.start({ repo: "owner/repo", issue: 454, cwd: data.workspace, yes: true });
    assert.equal(started.kind, "started");
    if (started.kind !== "started") throw new Error("expected started");
    assert.equal(started.receipt.nfgPath, join(auditDirectory(data.workspace, "issue-454"), "audit.json"));
    assert.equal(started.receipt.nfgPath, published.path);
    assert.ok(existsSync(started.receipt.nfgPath));
  } finally {
    data.cleanup();
  }
});
