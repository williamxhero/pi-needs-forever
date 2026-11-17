import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Host } from "../src/host.js";
import { createNeedsForever, type HandoffRuntime, type IssueReader } from "../src/needs-forever.js";

const MODEL = { provider: "faux", modelId: "faux-model" };
const ROOT_RULE = "Root rule: retain the user's unrelated notes and use the nested project's required label.";
const PROJECT_RULE = "Projects rule: every changed source must retain its project header.";
const ALPHA_RULE = "Alpha rule: the new value must be alpha-ready.";
const BETA_RULE = "Beta source rule: the new value must be beta-ready.";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "pi-nf-root-development-"));
  const workspace = join(parent, "workspace");
  const alpha = join(workspace, "projects", "alpha");
  const beta = join(workspace, "projects", "beta");
  for (const path of [workspace, alpha, beta]) {
    mkdirSync(join(path, "src"), { recursive: true });
    git(path, "init", "-b", "main");
    git(path, "config", "user.name", "Root fixture");
    git(path, "config", "user.email", "root-fixture@example.invalid");
    git(path, "config", "core.autocrlf", "false");
  }
  writeFileSync(join(workspace, ".gitignore"), "projects/alpha/\nprojects/beta/\n");
  writeFileSync(join(workspace, "AGENTS.md"), ROOT_RULE);
  writeFileSync(join(workspace, "projects", "AGENTS.md"), PROJECT_RULE);
  writeFileSync(join(alpha, "AGENTS.md"), ALPHA_RULE);
  writeFileSync(join(beta, "src", "AGENTS.md"), BETA_RULE);
  for (const [name, path] of [["root", workspace], ["alpha", alpha], ["beta", beta]]) {
    writeFileSync(join(path!, "src", "value.txt"), `${name} header\nold\n`);
    writeFileSync(join(path!, "notes.txt"), "original notes\n");
    git(path!, "add", "--", ".");
    git(path!, "commit", "-m", "fixture baseline");
    git(path!, "remote", "add", "origin", `https://github.com/fixture/${name}.git`);
    writeFileSync(join(path!, "notes.txt"), "user's pre-existing dirty notes\n");
    writeFileSync(join(path!, "untracked.txt"), "user's untracked work\n");
  }
  return { parent, workspace, alpha, beta, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}

function task(workspace: string, authorization = "Develop both nested projects; no push or Issue closure is authorized.") {
  return {
    schema_version: 1,
    task_id: "root-development",
    workspace,
    goal: "Update alpha and beta from this root Session",
    acceptance: [{ id: "A1", text: "Both nested projects obey their directory rules" }],
    authorization,
    c2: { mode: "legacy" },
    limits: { max_worker_turns: null, max_minutes: null },
  };
}

function tool(name: string, args: Parameters<typeof fauxToolCall>[1]): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

function scriptedModels(steps: FauxResponseStep[]) {
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "faux-model", name: "Faux Model" }] });
  models.setProvider(faux.provider);
  faux.setResponses(steps);
  return models;
}

function systemText(context: TranscriptContext): string {
  return context.messages.filter((message) => message.role === "system").map((message) => [
    typeof message.content === "string" ? message.content : message.content.map((block) => block.text).join("\n"),
    ...Object.values(message.sections ?? {}),
  ].join("\n")).join("\n");
}

function toolText(context: TranscriptContext): string {
  return context.messages.filter((message) => message.role === "toolResult").map((message) => JSON.stringify(message)).join("\n");
}

function lastToolOutput(context: TranscriptContext): string {
  const result = context.messages.findLast((message) => message.role === "toolResult");
  assert.ok(result && result.role === "toolResult" && !result.isError, "real tool must succeed");
  return result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function editSteps(observed: string[]): FauxResponseStep[] {
  return [
    tool("read", { path: "AGENTS.md" }),
    tool("read", { path: "projects/AGENTS.md" }),
    tool("read", { path: "projects/alpha/AGENTS.md" }),
    tool("read", { path: "projects/beta/src/AGENTS.md" }),
    (context) => {
      observed.push(toolText(context));
      return tool("edit", { path: "projects/alpha/src/value.txt", edits: [{ oldText: "old", newText: "alpha-ready" }] });
    },
    tool("edit", { path: "projects/beta/src/value.txt", edits: [{ oldText: "old", newText: "beta-ready" }] }),
  ];
}

function assertDirtyPreserved(data: ReturnType<typeof fixture>) {
  for (const path of [data.workspace, data.alpha, data.beta]) {
    assert.equal(readFileSync(join(path, "notes.txt"), "utf8"), "user's pre-existing dirty notes\n");
    assert.equal(readFileSync(join(path, "untracked.txt"), "utf8"), "user's untracked work\n");
  }
}

test("a fresh root Host acquires root and more-specific instructions before editing two nested Git projects", { timeout: 30_000 }, async () => {
  const data = fixture();
  const prompts: string[] = [];
  const beforeEdit: string[] = [];
  const cwdCommand = `node -e 'require("node:fs").writeFileSync("worker-cwd.txt", process.cwd())'`;
  const host = await Host.open({
    storage: await openNodeSqliteStorage(join(data.parent, "state.sqlite")),
    models: scriptedModels([
      (context) => {
        prompts.push(systemText(context));
        return tool("bash", { command: cwdCommand });
      },
      ...editSteps(beforeEdit),
      fauxAssistantMessage("Both projects updated; awaiting independent verification."),
    ]),
    model: MODEL,
    contract: task(data.workspace),
    db_path: join(data.parent, "state.sqlite"),
  });
  try {
    // No launcher conversation or launcher-read rules are supplied to this new worker.
    await host.start();
    await host.waitForIdle();
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /Workspace:.*workspace/);
    assert.match(prompts[0]!, /Before.*edit.*read.*AGENTS\.md/i);
    assert.match(prompts[0]!, /more-specific.*AGENTS\.md/i);
    assert.match(prompts[0]!, /launcher.*not.*inherited/i);
    assert.match(prompts[0]!, /nested.*Git.*do not.*workspace/i);
    assert.match(prompts[0]!, /outside.*symlink.*junction/i);
    assert.match(prompts[0]!, /dirty.*stash.*reset/i);
    assert.match(prompts[0]!, /STOP.*FAIL.*time.*gate/i);
    assert.equal(readFileSync(join(data.workspace, "worker-cwd.txt"), "utf8"), data.workspace);
    assert.equal(beforeEdit.length, 1);
    for (const rule of [ROOT_RULE, PROJECT_RULE, ALPHA_RULE, BETA_RULE]) assert.ok(beforeEdit[0]!.includes(rule), rule);
    assert.equal(readFileSync(join(data.alpha, "src", "value.txt"), "utf8"), "alpha header\nalpha-ready\n");
    assert.equal(readFileSync(join(data.beta, "src", "value.txt"), "utf8"), "beta header\nbeta-ready\n");
    assertDirtyPreserved(data);
    assert.equal((await host.inspect()).status, "ACTIVE", "a worker claim alone does not complete the task");
  } finally {
    await host.close();
    data.cleanup();
  }
});

test("root worker commits only owned paths in each Git history and pushes only when task-authorized", { timeout: 60_000 }, async (t) => {
  for (const authorized of [false, true]) await t.test(authorized ? "authorized push" : "push not authorized", async () => {
    const data = fixture();
    const bare = join(data.parent, "delivery.git");
    git(data.parent, "init", "--bare", bare);
    git(data.alpha, "remote", "add", "delivery", bare);
    const rootHead = git(data.workspace, "rev-parse", "HEAD");
    const betaHead = git(data.beta, "rev-parse", "HEAD");
    const prompts: string[] = [];
    const outputs: string[] = [];
    const authorization = authorized
      ? "Commit only src/value.txt in alpha and beta; push alpha main to local delivery after checking both source results."
      : "Commit only src/value.txt in alpha and beta; no push is authorized.";
    const host = await Host.open({
      storage: await openNodeSqliteStorage(join(data.parent, "state.sqlite")),
      models: scriptedModels([
        (context) => {
          prompts.push(systemText(context));
          return tool("bash", { command: "git -C projects/alpha status --short && git -C projects/beta status --short" });
        },
        ...editSteps([]),
        tool("bash", { command: "git -C projects/alpha add -- src/value.txt && git -C projects/alpha diff --cached --name-only && git -C projects/beta add -- src/value.txt && git -C projects/beta diff --cached --name-only" }),
        (context) => {
          outputs.push(lastToolOutput(context));
          return tool("bash", { command: "git -C projects/alpha commit -m 'alpha task change' && git -C projects/beta commit -m 'beta task change'" });
        },
        (context) => {
          // This cooperative provider uses the delivered authorization, not a shell-security wrapper.
          const prompt = systemText(context);
          return prompt.includes("push alpha main to local delivery")
            ? tool("bash", { command: "git -C projects/alpha push delivery main" })
            : fauxAssistantMessage("Commits made; push withheld because it is not authorized.");
        },
        fauxAssistantMessage("Authorized Git work complete."),
      ]),
      model: MODEL,
      contract: task(data.workspace, authorization),
      db_path: join(data.parent, "state.sqlite"),
    });
    try {
      await host.start();
      await host.waitForIdle();
      assert.match(prompts[0]!, /Git.*target repository.*git -C/);
      assert.match(prompts[0]!, /stage.*explicit paths.*inspect.*staged/i);
      assert.match(prompts[0]!, /commit.*merge.*push.*authorization.*delivery gates/i);
      assert.match(prompts[0]!, /not.*human-only/i);
      assert.match(prompts[0]!, /never force-push/i);
      assert.ok(prompts[0]!.includes(`Authorization: ${authorization}`));
      assert.equal(outputs[0]!.trim(), "src/value.txt\nsrc/value.txt", "the worker receives only the two owned staged paths before commit");
      assert.equal(git(data.workspace, "rev-parse", "HEAD"), rootHead);
      assert.equal(git(data.beta, "rev-parse", "HEAD~1"), betaHead);
      assert.equal(git(data.alpha, "show", "--format=", "--name-only", "HEAD"), "src/value.txt");
      assert.equal(git(data.beta, "show", "--format=", "--name-only", "HEAD"), "src/value.txt");
      assert.equal(git(data.alpha, "show", "HEAD:src/value.txt"), "alpha header\nalpha-ready");
      assert.equal(git(data.beta, "show", "HEAD:src/value.txt"), "beta header\nbeta-ready");
      for (const path of [data.workspace, data.alpha, data.beta]) {
        assert.equal(git(path, "diff", "--cached", "--name-only"), "");
        assert.match(git(path, "status", "--porcelain"), /^M notes\.txt/m);
        assert.equal(git(path, "ls-files", "projects/alpha/src/value.txt", "projects/beta/src/value.txt"), "");
      }
      assertDirtyPreserved(data);
      const refs = git(data.parent, "--git-dir", bare, "for-each-ref", "--format=%(objectname)", "refs/heads/main");
      assert.equal(refs, authorized ? git(data.alpha, "rev-parse", "HEAD") : "");
    } finally {
      await host.close();
      data.cleanup();
    }
  });
});

test("root preview/start keeps workspace while same-number GitHub reads and authorized UTF-8 updates select a repository", { timeout: 60_000 }, async (t) => {
  for (const closeAuthorized of [false, true]) await t.test(closeAuthorized ? "authorized closure" : "closure not authorized", async () => {
    const data = fixture();
    const body = "## 中文交付\n- [x] 两个子项目已验证；保留原有改动。\n";
    const ghPath = join(data.parent, "gh.mjs");
    writeFileSync(ghPath, readFileSync(fileURLToPath(new URL("../../test/fixtures/root-gh.mjs", import.meta.url))));
    const initialBody = "- [ ] Validate the selected repository";
    for (const name of ["alpha", "beta"]) writeFileSync(join(data.parent, `${name}-issue.json`), JSON.stringify({
      number: 7, title: `${name} requirement`, body: initialBody,
      url: `https://github.com/fixture/${name}/issues/7`, state: "OPEN",
    }));
    const issueReads: { repo: string; issue: number; cwd: string }[] = [];
    const issueReader: IssueReader = async (repo, issue, cwd) => {
      issueReads.push({ repo, issue, cwd });
      const result = JSON.parse(execFileSync(process.execPath, [ghPath, "issue", "view", String(issue), "--repo", repo, "--json", "number,title,body,url,state"], { cwd, encoding: "utf8" }));
      return { repo, ...result };
    };
    const authorization = "Update fixture/beta#7 using a UTF-8 body file and read it back. " + (closeAuthorized
      ? "Close fixture/beta#7 after body readback."
      : "No Issue closure or push is authorized.");
    writeFileSync(join(data.workspace, ".needs-forever.json"), JSON.stringify({
      workspace: ".", authorization, c2: { mode: "legacy" },
      verify: { argv: [process.execPath, "-e", "process.exit(0)"], timeout_seconds: 10, protected_files: [] },
    }));
    const gh = `node '${ghPath.replaceAll("\\", "/")}'`;
    const prompts: string[] = [];
    const readbacks: string[] = [];
    let host: Host | undefined;
    const launches: string[] = [];
    const runtime: HandoffRuntime = {
      async launch(input) {
        launches.push(input.workspace);
        host = await Host.open({
          storage: await openNodeSqliteStorage(input.dbPath),
          models: scriptedModels([
            (context) => {
              prompts.push(systemText(context));
              return tool("read", { path: "AGENTS.md" });
            },
            tool("write", { path: "issue-body.md", content: body }),
            tool("bash", { command: `${gh} issue edit 7 --repo fixture/beta --body-file issue-body.md && ${gh} issue view 7 --repo fixture/beta --json body` }),
            (context) => {
              const output = lastToolOutput(context);
              readbacks.push(output);
              const readback = JSON.parse(output.slice(output.indexOf("{"))) as { body: string };
              return readback.body === body && systemText(context).includes("Close fixture/beta#7 after body readback.")
                ? tool("bash", { command: `${gh} issue close 7 --repo fixture/beta` })
                : fauxAssistantMessage("Updated and read back; closure is not authorized.");
            },
            fauxAssistantMessage("Authorized tracker operations complete."),
          ]),
          model: MODEL,
          contract: JSON.parse(readFileSync(input.contractPath, "utf8")),
          db_path: input.dbPath,
        });
        await host.start();
        await host.waitForIdle();
        return { pid: 777 };
      },
      isAlive: (pid) => pid === 777,
      terminate() {},
    };
    const needs = createNeedsForever({ cwd: data.workspace, home: join(data.parent, "nf-home"), issueReader, runtime });
    try {
      const alpha = await needs.preview({ repo: "fixture/alpha", issue: 7 });
      const beta = await needs.preview({ repo: "fixture/beta", issue: 7 });
      assert.equal(alpha.contract?.goal, "alpha requirement");
      assert.equal(beta.contract?.goal, "beta requirement");
      assert.equal(alpha.requestKey, "fixture/alpha#7");
      assert.equal(beta.requestKey, "fixture/beta#7");
      assert.equal(alpha.contract?.workspace, data.workspace);
      assert.equal(beta.contract?.workspace, data.workspace);
      assert.deepEqual(alpha.gaps, []);
      assert.deepEqual(beta.gaps, []);
      assert.equal(launches.length, 0, "preview does not launch or mutate");
      const result = await needs.start({ repo: "fixture/beta", issue: 7, yes: true });
      assert.equal(result.kind, "started");
      if (result.kind !== "started") throw new Error("expected started");
      assert.equal(result.receipt.workspace, data.workspace);
      assert.equal(result.receipt.contractHash, beta.contractHash);
      assert.equal(result.receipt.requestKey, "fixture/beta#7");
      assert.deepEqual(launches, [data.workspace]);
      assert.ok(issueReads.every((read) => read.cwd === data.workspace && read.issue === 7));
      assert.deepEqual(issueReads.map((read) => read.repo), ["fixture/alpha", "fixture/beta", "fixture/beta"]);
      assert.match(prompts[0]!, /GitHub.*explicit.*repository.*--repo/);
      assert.match(prompts[0]!, /Chinese.*UTF-8.*without BOM.*--body-file.*read back/i);
      assert.match(prompts[0]!, /not.*PowerShell.*pipeline/i);
      assert.ok(prompts[0]!.includes(authorization));
      assert.equal(JSON.parse(readbacks[0]!.slice(readbacks[0]!.indexOf("{"))).body, body, "the provider receives and compares the exact uploaded body readback");
      const uploaded = readFileSync(join(data.workspace, "issue-body.md"));
      assert.equal(uploaded.subarray(0, 3).toString("hex") === "efbbbf", false);
      assert.equal(uploaded.toString("utf8"), body);
      const storedBeta = JSON.parse(readFileSync(join(data.parent, "beta-issue.json"), "utf8"));
      const storedAlpha = JSON.parse(readFileSync(join(data.parent, "alpha-issue.json"), "utf8"));
      assert.equal(storedBeta.body, body);
      assert.equal(storedBeta.state, closeAuthorized ? "CLOSED" : "OPEN");
      assert.equal(storedAlpha.body, initialBody);
      assert.equal(storedAlpha.state, "OPEN");
      const calls = readFileSync(join(data.parent, "gh-calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const updates = calls.filter((call) => call.args[1] !== "view");
      assert.deepEqual(updates.map((call) => [call.repo, call.args[1]]), closeAuthorized
        ? [["fixture/beta", "edit"], ["fixture/beta", "close"]]
        : [["fixture/beta", "edit"]]);
      assert.ok(calls.every((call) => call.cwd === data.workspace));
      assertDirtyPreserved(data);
    } finally {
      await host?.close();
      data.cleanup();
    }
  });
});
