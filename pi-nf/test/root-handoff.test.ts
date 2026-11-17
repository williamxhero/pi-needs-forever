import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Host } from "../src/host.js";
import { contractHash } from "../src/contract.js";
import { readAudit, writeAudit } from "../src/audit.js";
import { DetachedCliRuntime, createNeedsForever, type HandoffReceipt } from "../src/needs-forever.js";
import { startWebServer } from "../src/web.js";
import type { VerificationResult } from "../src/verify.js";

const executable = fileURLToPath(new URL("./fixtures/root-handoff.js", import.meta.url));
const example = fileURLToPath(new URL("../../examples/root-workspace", import.meta.url));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => T | undefined | Promise<T | undefined>, description: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${description}`);
}
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

test("root Pi handoff survives launcher exit and gates both independent Git projects in the same durable task", { timeout: 90_000 }, async (t) => {
  for (const failure of ["alpha", "beta", null]) await t.test(failure ? `${failure} fails: never DONE` : "both pass: DONE and read-only root audit", async () => {
    const parent = mkdtempSync(join(tmpdir(), "pi-nf-root-handoff-"));
    const root = join(parent, "workspace");
    const reserved = join(root, ".pi-nf");
    const runtime = new DetachedCliRuntime();
    let receipt: HandoffReceipt | undefined;
    let childPid: number | null = null;
    try {
      cpSync(example, root, { recursive: true });
      mkdirSync(reserved, { recursive: true });
      writeFileSync(join(reserved, "scenario.json"), JSON.stringify({ failure }));
      const configPath = join(root, "needs-forever.json");
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      // Faux judge uses the existing legacy policy; one completed round bounds failed-gate repair.
      config.c2 = { mode: "legacy" };
      config.limits.max_worker_turns = 1;
      config.verify.argv[0] = process.execPath;
      writeFileSync(configPath, JSON.stringify(config));
      const heads: string[] = [];
      for (const name of ["alpha", "beta"]) {
        const repo = join(root, "projects", name);
        git(repo, "init", "-b", "main");
        git(repo, "config", "user.name", "Handoff fixture");
        git(repo, "config", "user.email", "fixture@example.invalid");
        git(repo, "add", "--", "AGENTS.md", "check.mjs", "src/value.txt");
        git(repo, "commit", "-m", "independent baseline");
        git(repo, "remote", "add", "origin", `https://github.com/fixture/${name}.git`);
        heads.push(git(repo, "rev-parse", "HEAD"));
        writeFileSync(join(repo, "notes.txt"), "unrelated user work\n");
      }
      // This launcher is a separate real process, not this test masquerading as a runtime.
      const launched = JSON.parse(execFileSync(process.execPath, [executable, "launcher", root], {
        encoding: "utf8", windowsHide: true, timeout: 25_000,
      })) as { receipt: HandoffReceipt; notifications: string[]; previewHash: string };
      receipt = launched.receipt;
      childPid = receipt.pid;
      assert.ok(childPid && childPid !== process.pid);
      assert.equal(runtime.isAlive(childPid), true, "child is alive after launcher process has exited");
      assert.match(launched.notifications.join("\n"), /Started a new A session/);
      assert.match(launched.notifications.join("\n"), /launcher\/observer/);
      assert.equal(receipt.workspace, root);
      assert.equal(receipt.contractHash, launched.previewHash);
      assert.equal(receipt.requestKey, "fixture/root#7");
      assert.equal((await Host.status(receipt.stateDb)).task_id, receipt.taskId);
      const contract = await Host.readContract(receipt.stateDb);
      assert.equal(contract.workspace, root);
      assert.equal(contractHash(contract), receipt.contractHash);
      assert.deepEqual(contract.verify?.argv, [process.execPath, "verify.mjs"]);
      assert.equal(JSON.parse(readFileSync(receipt.contractPath, "utf8")).workspace, root);
      // First provider request waits here: no edits/gate can finish before real readiness/receipt.
      for (const name of ["alpha", "beta"]) assert.equal(readFileSync(join(root, "projects", name, "src/value.txt"), "utf8"), `${name}-pending\n`);
      writeFileSync(join(reserved, "release-worker"), "launcher has exited\n");
      const statusPath = join(reserved, "finished.json");
      const final = await until(() => existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, "utf8")) : undefined, "child inspect and audit publication");
      const status = await Host.status(receipt.stateDb);
      assert.deepEqual(status, final, "child inspect and reopened SQLite status agree");
      assert.equal(status.task_id, receipt.taskId);
      assert.equal(status.status, failure ? "PAUSED" : "DONE");
      assert.equal(status.verification.state, failure ? "failed" : "passed");
      const result = status.verification.last_result as VerificationResult;
      assert.equal(result.passed, !failure);
      assert.equal(result.exit_code, failure ? 1 : 0);
      assert.equal(result.workspace_changed, false);
      assert.deepEqual(result.protected_before, []);
      assert.deepEqual(result.protected_after, []);
      assert.match(result.stdout, new RegExp(`alpha: ${failure === "alpha" ? "FAIL" : "PASS"}`));
      assert.match(result.stdout, new RegExp(`beta: ${failure === "beta" ? "FAIL" : "PASS"}`));
      const locations = result.stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
      assert.equal(locations[0].root, root);
      assert.deepEqual(locations.slice(1).map((value) => value.cwd), [join(root, "projects/alpha"), join(root, "projects/beta")]);
      if (failure) assert.equal(status.last_decision?.action, "CONTINUE", "a faux DONE judgment cannot bypass a failed child check");
      for (const [index, name] of ["alpha", "beta"].entries()) {
        const repo = join(root, "projects", name);
        assert.equal(readFileSync(join(repo, "src/value.txt"), "utf8"), `${name}-${failure === name ? "blocked" : "ready"}\n`);
        assert.equal(git(repo, "rev-parse", "HEAD"), heads[index]);
        assert.equal(git(repo, "diff", "--cached", "--name-only"), "");
        assert.equal(readFileSync(join(repo, "notes.txt"), "utf8"), "unrelated user work\n");
      }
      assert.equal(readFileSync(receipt.stateDb).subarray(0, 15).toString(), "SQLite format 3");
      const published = JSON.parse(readFileSync(receipt.nfgPath, "utf8"));
      assert.equal(receipt.nfgPath, join(root, ".pi-nf", receipt.taskId, "audit.json"));
      assert.equal(published.schema_version, 2);
      assert.equal(published.task_id, receipt.taskId);
      assert.equal(published.contract.workspace, root);
      assert.equal(contractHash(published.contract), receipt.contractHash);
      assert.equal(published.control.status, status.status);
      assert.deepEqual(published.verification, status.verification);
      // Observe the same committed task through existing read-only adapters, not a second Host.
      const before = await Host.status(receipt.stateDb);
      const rebuilt = await writeAudit(receipt.stateDb);
      assert.equal(rebuilt.path, receipt.nfgPath);
      assert.deepEqual((await readAudit(receipt.stateDb)).verification, published.verification);
      const web = await startWebServer({ db_path: receipt.stateDb });
      try {
        const response = await fetch(`${web.url}api/status`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), before);
      } finally { await web.close(); }
      assert.deepEqual(await Host.status(receipt.stateDb), before);
      const needs = createNeedsForever({ cwd: root, home: join(reserved, "home"), issueReader: async () => null });
      assert.equal((await needs.inspect("fixture/root#7"))?.taskId, receipt.taskId);
    } catch (error) {
      if (receipt && existsSync(receipt.logPath)) console.error(readFileSync(receipt.logPath, "utf8"));
      throw error;
    } finally {
      // PID sidecar covers exceptions even before the launcher can return a receipt.
      if (childPid === null && existsSync(join(reserved, "child-pid"))) childPid = Number(readFileSync(join(reserved, "child-pid"), "utf8"));
      if (runtime.isAlive(childPid)) runtime.terminate(childPid);
      await until(() => !runtime.isAlive(childPid) ? true : undefined, "detached child termination");
      rmSync(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
});
