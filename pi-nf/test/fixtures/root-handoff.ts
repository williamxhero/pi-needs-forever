// Explicit test executable Adapter for DetachedCliRuntime.cliPath. Only worker models,
// judge and IssueReader are faux: Host, SQLite, CodingTools, gate and audit are production.
import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { Host } from "../../src/host.js";
import { writeAudit } from "../../src/audit.js";
import { createNeedsForever, DetachedCliRuntime, type HandoffReceipt } from "../../src/needs-forever.js";
import { createNeedsForeverExtension, type PiExtensionApi } from "../../src/needs-forever-command.js";
import type { Judge } from "../../src/judge.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(path: string, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`fixture synchronization timeout: ${path}`);
    await delay(25);
  }
}
function tool(name: string, args: Parameters<typeof fauxToolCall>[1]) {
  return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}
function assertSuccessfulTools(context: TranscriptContext) {
  for (const result of context.messages.filter((message) => message.role === "toolResult")) {
    assert.equal(result.isError, false, JSON.stringify(result));
  }
}

async function launcher(root: string) {
  const runtime = new DetachedCliRuntime();
  const needs = createNeedsForever({
    cwd: root,
    home: join(root, ".pi-nf", "home"),
    cliPath: fileURLToPath(import.meta.url),
    // No GitHub network/credentials; explicit selected repository is still asserted.
    issueReader: async (repo, issue, cwd) => {
      assert.equal(repo, "fixture/root");
      assert.equal(issue, 7);
      assert.equal(cwd, root);
      return { repo, number: issue, title: "Two project requirement", body: "- [ ] Both projects ready", url: "https://example.invalid/7", state: "OPEN" };
    },
  });
  let receipt: HandoffReceipt | null = null;
  try {
    const preview = await needs.preview({ repo: "fixture/root", issue: 7 });
    assert.deepEqual(preview.gaps, []);
    assert.equal(preview.source, "project");
    assert.equal(preview.contract?.workspace, root);
    assert.equal(existsSync(join(root, ".pi-nf", "home")), false, "preview must remain side-effect free");
    const notifications: string[] = [];
    let handler: Parameters<PiExtensionApi["registerCommand"]>[1]["handler"] | undefined;
    createNeedsForeverExtension(needs)({ registerCommand(name, command) {
      assert.equal(name, "needs-forever");
      handler = command.handler;
    } });
    assert.ok(handler);
    await handler("7 --repo fixture/root --yes", { cwd: root, ui: { notify(message, level) {
      assert.notEqual(level, "error", message);
      notifications.push(message);
    } } });
    receipt = await needs.inspect("fixture/root#7");
    assert.ok(receipt);
    assert.equal(receipt.contractHash, preview.contractHash);
    console.log(JSON.stringify({ receipt, notifications, previewHash: preview.contractHash }));
  } catch (error) {
    const pid = receipt?.pid ?? (existsSync(join(root, ".pi-nf", "child-pid")) ? Number(readFileSync(join(root, ".pi-nf", "child-pid"), "utf8")) : null);
    runtime.terminate(pid);
    throw error;
  }
}

async function worker(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { task: { type: "string" }, db: { type: "string" } } });
  assert.equal(positionals[0], "start");
  assert.ok(values.task && values.db);
  const root = process.cwd();
  const reserved = join(root, ".pi-nf");
  writeFileSync(join(reserved, "child-pid"), String(process.pid));
  const scenario = JSON.parse(readFileSync(join(reserved, "scenario.json"), "utf8")) as { failure: string | null };
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "faux-model", name: "Faux Model" }] });
  models.setProvider(faux.provider);
  const steps: FauxResponseStep[] = [
    async (context) => {
      const system = JSON.stringify(context.messages.filter((message) => message.role === "system"));
      assert.ok(system.includes(root.replaceAll("\\", "\\\\")), "new A receives root workspace");
      assert.match(system, /launcher.*not.*inherited/i);
      assert.match(system, /Before.*edit.*read.*AGENTS/i);
      // Prevent the worker from racing the real production readiness Host.status probe.
      // Marker is reserved supervisor output, excluded from checked source, not a new public model.
      await waitFor(join(reserved, "release-worker"));
      return tool("read", { path: "AGENTS.md" });
    },
    tool("read", { path: "projects/alpha/AGENTS.md" }),
    tool("read", { path: "projects/beta/AGENTS.md" }),
    (context) => {
      assertSuccessfulTools(context);
      const results = JSON.stringify(context.messages.filter((message) => message.role === "toolResult"));
      for (const rule of ["Root example rules", "Alpha rules", "Beta rules"]) assert.ok(results.includes(rule), `new A must obtain ${rule} before edits`);
      return tool("edit", { path: "projects/alpha/src/value.txt", edits: [{ oldText: "alpha-pending", newText: scenario.failure === "alpha" ? "alpha-blocked" : "alpha-ready" }] });
    },
    tool("edit", { path: "projects/beta/src/value.txt", edits: [{ oldText: "beta-pending", newText: scenario.failure === "beta" ? "beta-blocked" : "beta-ready" }] }),
    tool("bash", { command: "node -e 'console.log(JSON.stringify({workerCwd:process.cwd(),pid:process.pid}))'" }),
    (context) => {
      assertSuccessfulTools(context);
      const result = context.messages.findLast((message) => message.role === "toolResult");
      assert.ok(result && result.role === "toolResult");
      const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      const cwd = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      assert.equal(cwd.workerCwd, root, "actual CodingTools subprocess uses root cwd");
      return fauxAssistantMessage("Both nested files edited by this A; request independent root verification.");
    },
  ];
  faux.setResponses(steps);
  let workerThread: string | undefined;
  const judge: Judge = { async decide(snapshot) {
    assert.equal(snapshot.task.workspace, root);
    workerThread ??= snapshot.worker_thread_id;
    assert.equal(snapshot.worker_thread_id, workerThread);
    assert.ok(snapshot.evidence.length > 0, "DONE judgment requires actual tool evidence");
    return { action: "DONE", reason: "Fixture judgment; only the real root gate may admit DONE", evidence_ids: snapshot.evidence.map((item) => item.id), next_message: "", external: null };
  } };
  const host = await Host.openSqlite({ db_path: values.db, contract_path: values.task, models, model: { provider: "faux", modelId: "faux-model" }, judge });
  try {
    await host.start();
    await host.waitForIdle();
    const checked = await host.inspect();
    assert.equal(checked.verification.state, scenario.failure ? "failed" : "passed");
    if (scenario.failure) {
      assert.equal(checked.status, "ACTIVE");
      assert.equal(checked.last_decision?.action, "CONTINUE");
      // Stop this negative fixture at its failed gate instead of starting unbounded repair.
      await host.pause();
    }
    const status = await host.inspect();
    await writeAudit(values.db);
    writeFileSync(join(reserved, "finished.tmp"), JSON.stringify(status));
    renameSync(join(reserved, "finished.tmp"), join(reserved, "finished.json"));
  } finally { await host.close(); }
}

const watchdog = setTimeout(() => { console.error("root handoff fixture watchdog expired"); process.exit(1); }, 40_000);
try {
  if (process.argv[2] === "launcher") await launcher(process.argv[3]!);
  else await worker(process.argv.slice(2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally { clearTimeout(watchdog); }
