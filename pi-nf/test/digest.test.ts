import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { writeAudit } from "../src/audit.js";
import { Host } from "../src/host.js";
import { FixtureJudge } from "../src/judge.js";
import type { TaskContract } from "../src/types.js";
import { recordProtectedBaseline, runCompletionGate, workspaceDigest } from "../src/verify.js";

function contract(workspace: string, script: string): TaskContract {
  return {
    schema_version: 1, task_id: "digest-task", workspace, goal: "root verification",
    acceptance: [{ id: "A1", text: "root stays consistent" }], authorization: "local",
    c2: { mode: "legacy" }, limits: { max_worker_turns: null, max_minutes: null },
    verify: { argv: [process.execPath, "-e", script], timeout_seconds: 10, protected_files: [] },
  };
}

test("workspaceDigest scans a large file with bounded memory and repeatable results", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/digest-benchmark.js", import.meta.url)), "256", "16", "2"], {
    encoding: "utf8", timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const scans = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as { digest: string; peak_rss_kib: number });
  assert.equal(scans.length, 2);
  assert.equal(scans[0]!.digest, scans[1]!.digest);
  for (const scan of scans) assert.ok(scan.peak_rss_kib < 192 * 1024, `peak RSS ${scan.peak_rss_kib} KiB exceeds 192 MiB`);
});

test("workspaceDigest bounds memory with several large files and many small files together", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/digest-benchmark.js", import.meta.url)), "32", "257", "2", "8"], {
    encoding: "utf8", timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const scans = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as { digest: string; peak_rss_kib: number });
  assert.equal(scans.length, 2);
  assert.equal(scans[0]!.digest, scans[1]!.digest);
  for (const scan of scans) assert.ok(scan.peak_rss_kib < 192 * 1024, `peak RSS ${scan.peak_rss_kib} KiB exceeds 192 MiB`);
});

test("workspaceDigest distinguishes file names from content instead of concatenating ambiguously", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-digest-framing-"));
  try {
    writeFileSync(join(workspace, "a"), "bc");
    const before = await workspaceDigest(workspace, null);
    rmSync(join(workspace, "a"));
    writeFileSync(join(workspace, "ab"), "c");
    assert.notEqual(await workspaceDigest(workspace, null), before);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("workspaceDigest does not treat project settings, scratch source or worktrees as generated caches", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-digest-source-"));
  try {
    for (const directory of [".pi", ".nf", ".scratch", ".worktrees", "runtime", "artifacts", "tests", "tools", "docs", "source"]) {
      mkdirSync(join(workspace, directory));
      const before = await workspaceDigest(workspace, null);
      writeFileSync(join(workspace, directory, "project.ts"), "export const value = 1;");
      assert.notEqual(await workspaceDigest(workspace, null), before, directory);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("CompletionGate detects source changes in a cache-named independent repository", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-collision-"));
  try {
    const repo = join(workspace, "venv");
    mkdirSync(repo);
    execFileSync("git", ["init", "--quiet", repo]);
    writeFileSync(join(repo, "main.ts"), "original");
    const task = contract(workspace, "require('node:fs').writeFileSync('venv/main.ts', 'changed')");
    const result = await runCompletionGate({ task, baseline: [], state_path: null,
      env: new NodeExecutionEnv({ cwd: workspace }), context: BACKGROUND_CONTEXT });
    assert.equal(result.exit_code, 0);
    assert.equal(result.workspace_changed, true);
    assert.equal(result.passed, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("CompletionGate detects changes in a repository deep inside a marked venv", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-deep-cache-"));
  try {
    const repo = join(workspace, "venv", "projects", "alpha");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(workspace, "venv", "pyvenv.cfg"), "marker");
    execFileSync("git", ["init", "--quiet", repo]);
    writeFileSync(join(repo, "source.ts"), "before");
    const task = contract(workspace, "require('node:fs').writeFileSync('venv/projects/alpha/source.ts', 'after')");
    const result = await runCompletionGate({ task, baseline: [], state_path: null,
      env: new NodeExecutionEnv({ cwd: workspace }), context: BACKGROUND_CONTEXT });
    assert.equal(result.exit_code, 0);
    assert.equal(result.workspace_changed, true);
    assert.equal(result.passed, false);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("workspaceDigest discovers deep repositories in generated containers without hashing payload or following links", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-discovery-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-nf-discovery-outside-"));
  try {
    const origin = join(workspace, "origin");
    execFileSync("git", ["init", "--quiet", origin]);
    execFileSync("git", ["-C", origin, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "initial", "--quiet"]);
    for (const [container, marker, content] of [["node_modules", ".package-lock.json", "marker"], [".pytest_cache", "CACHEDIR.TAG", "Signature: 8a477f597d28d172789f06886806bc55\n"], [".pi-nf", "audit.json", "state"]]) {
      const dir = join(workspace, container!);
      mkdirSync(dir);
      writeFileSync(join(dir, marker!), content!);
      mkdirSync(join(dir, "projects", "deeper"), { recursive: true });
      const repo = join(dir, "projects", "deeper", "alpha");
      execFileSync("git", ["init", "--quiet", repo]);
      writeFileSync(join(repo, "source.ts"), "before");
    }
    const worktree = join(workspace, "node_modules", "projects", "worktree");
    execFileSync("git", ["-C", origin, "worktree", "add", "--quiet", "-b", "fixture", worktree]);
    writeFileSync(join(worktree, "source.ts"), "before");
    symlinkSync(outside, join(workspace, "node_modules", "external"), process.platform === "win32" ? "junction" : "dir");
    let before = await workspaceDigest(workspace, null);
    writeFileSync(join(workspace, "node_modules", "generated"), "changed");
    writeFileSync(join(outside, "external.ts"), "changed");
    assert.equal(await workspaceDigest(workspace, null), before);
    for (const repo of [join(workspace, "node_modules", "projects", "deeper", "alpha"), join(workspace, ".pytest_cache", "projects", "deeper", "alpha"), join(workspace, ".pi-nf", "projects", "deeper", "alpha"), worktree]) {
      writeFileSync(join(repo, "source.ts"), "after");
      const after = await workspaceDigest(workspace, null);
      assert.notEqual(after, before, repo);
      before = after;
    }
    const added = join(workspace, ".pi-nf", "another", "new-repo");
    mkdirSync(added, { recursive: true });
    execFileSync("git", ["init", "--quiet", added]);
    writeFileSync(join(added, "new.ts"), "new");
    const withRepo = await workspaceDigest(workspace, null);
    assert.notEqual(withRepo, before);
    rmSync(added, { recursive: true, force: true });
    assert.equal(await workspaceDigest(workspace, null), before);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("workspaceDigest covers source files whose names collide with cache names", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-collision-files-"));
  try {
    for (const name of ["venv", "node_modules", ".pytest_cache", ".pi-nf", ".coverage.prod.ts"]) {
      const path = join(workspace, name);
      writeFileSync(path, "original");
      const before = await workspaceDigest(workspace, null);
      writeFileSync(path, "changed");
      assert.notEqual(await workspaceDigest(workspace, null), before, name);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("workspaceDigest covers unmarked cache-named directories and nested supervisor-like content", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-collision-dirs-"));
  try {
    for (const name of ["node_modules", "venv", ".pytest_cache", ".pi-nf", "htmlcov"]) {
      const directory = join(workspace, "project", name);
      mkdirSync(directory, { recursive: true });
      const file = join(directory, "source.ts");
      writeFileSync(file, "before");
      const before = await workspaceDigest(workspace, null);
      writeFileSync(file, "after");
      assert.notEqual(await workspaceDigest(workspace, null), before, name);
    }
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("workspaceDigest covers cache-named source with an unrelated cache tag", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-cache-tag-"));
  try {
    const dir = join(workspace, ".pytest_cache");
    mkdirSync(dir);
    writeFileSync(join(dir, "CACHEDIR.TAG"), "project notes");
    writeFileSync(join(dir, "source.ts"), "before");
    const before = await workspaceDigest(workspace, null);
    writeFileSync(join(dir, "source.ts"), "after");
    assert.notEqual(await workspaceDigest(workspace, null), before);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("workspaceDigest covers a regular .git file that is not worktree metadata", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-git-file-"));
  try {
    const file = join(workspace, ".git");
    writeFileSync(file, "project configuration");
    const before = await workspaceDigest(workspace, null);
    writeFileSync(file, "changed configuration");
    assert.notEqual(await workspaceDigest(workspace, null), before);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("workspaceDigest covers a non-repository .git directory", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-git-dir-"));
  try {
    const dir = join(workspace, ".git");
    mkdirSync(dir);
    writeFileSync(join(dir, "source.ts"), "before");
    const before = await workspaceDigest(workspace, null);
    writeFileSync(join(dir, "source.ts"), "after");
    assert.notEqual(await workspaceDigest(workspace, null), before);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("workspaceDigest covers unknown coverage and unmarked bytecode directories", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-unknown-generated-"));
  try {
    mkdirSync(join(workspace, "__pycache__"));
    for (const name of [".coverage", ".coverage.worker1", ".coverage.prod.ts", "__pycache__/module.pyc"]) {
      const file = join(workspace, name);
      writeFileSync(file, "before");
      const before = await workspaceDigest(workspace, null);
      writeFileSync(file, "after");
      assert.notEqual(await workspaceDigest(workspace, null), before, name);
    }
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("workspaceDigest covers a marked cache directory containing a Git worktree", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-worktree-cache-"));
  try {
    const repo = join(workspace, "repo");
    execFileSync("git", ["init", "--quiet", repo]);
    execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "initial", "--quiet"]);
    const worktree = join(workspace, "venv");
    execFileSync("git", ["-C", repo, "worktree", "add", "--quiet", "-b", "fixture", worktree]);
    writeFileSync(join(worktree, "pyvenv.cfg"), "marker");
    writeFileSync(join(worktree, "source.ts"), "before");
    const before = await workspaceDigest(workspace, null);
    writeFileSync(join(worktree, "source.ts"), "after");
    assert.notEqual(await workspaceDigest(workspace, null), before);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

function nestedRepositories(workspace: string): void {
  for (const name of ["alpha", "beta"]) {
    const path = join(workspace, name);
    mkdirSync(path);
    execFileSync("git", ["init", "--quiet", path]);
    writeFileSync(join(path, ".gitignore"), "ignored.ts\n");
    writeFileSync(join(path, "config.json"), '{"enabled":true}');
    writeFileSync(join(path, "untracked.ts"), "original source");
    writeFileSync(join(path, "ignored.ts"), "ignored source");
    execFileSync("git", ["-C", path, "add", ".gitignore", "config.json"]);
    assert.equal(execFileSync("git", ["-C", path, "check-ignore", "ignored.ts"], { encoding: "utf8" }).trim(), "ignored.ts");
  }
}

test("workspaceDigest keeps mixed many-file layouts deterministic and detects late nested source changes", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-digest-many-"));
  try {
    nestedRepositories(workspace);
    for (const directory of [workspace, join(workspace, "alpha"), join(workspace, "beta")]) {
      for (let i = 0; i < 19; i++) {
        writeFileSync(join(directory, `source-${String(i).padStart(2, "0")}.ts`), Buffer.alloc(i === 9 ? 150_000 : i * 37, i));
      }
    }
    const before = await workspaceDigest(workspace, null);
    assert.equal(await workspaceDigest(workspace, null), before);
    assert.equal(await workspaceDigest(workspace, null), before);
    const task = contract(workspace, "require('node:fs').writeFileSync('beta/source-18.ts', 'changed late source')");
    const result = await runCompletionGate({ task, baseline: [], state_path: null,
      env: new NodeExecutionEnv({ cwd: workspace }), context: BACKGROUND_CONTEXT });
    assert.equal(result.exit_code, 0);
    assert.equal(result.workspace_before, before);
    assert.notEqual(result.workspace_after, before);
    assert.equal(result.passed, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

for (const [label, script] of [
  ["tracked config", "fs.writeFileSync('alpha/config.json', '{}')"],
  ["untracked source", "fs.writeFileSync('beta/untracked.ts', 'changed')"],
  ["Git-ignored source", "fs.writeFileSync('beta/ignored.ts', 'changed')"],
  ["source addition", "fs.writeFileSync('alpha/new.ts', 'new source')"],
  ["source deletion", "fs.unlinkSync('beta/untracked.ts')"],
]) {
  test(`CompletionGate detects nested Git repository ${label} changes`, async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pi-nf-digest-nested-"));
    try {
      nestedRepositories(workspace);
      const before = await workspaceDigest(workspace, null);
      const task = contract(workspace, `const fs = require('node:fs'); ${script}`);
      const result = await runCompletionGate({ task, baseline: [], state_path: null,
        env: new NodeExecutionEnv({ cwd: workspace }), context: BACKGROUND_CONTEXT });
      assert.equal(result.exit_code, 0);
      assert.equal(result.workspace_before, before);
      assert.notEqual(result.workspace_after, before);
      assert.equal(result.workspace_changed, true);
      assert.equal(result.passed, false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
}

for (const excluded of [".pytest_cache"]) {
  test(`CompletionGate protects a nested file independently of excluded ${excluded} writes`, async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pi-nf-digest-protected-"));
    try {
      nestedRepositories(workspace);
      const directory = join(workspace, "alpha", excluded);
      mkdirSync(directory);
      writeFileSync(join(directory, "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n");
      const file = `alpha/${excluded}/acceptance.mjs`;
      writeFileSync(join(workspace, file), "original");
      const task = contract(workspace, `require('node:fs').writeFileSync(${JSON.stringify(file)}, 'tampered')`);
      task.verify!.protected_files = [file];
      const baseline = recordProtectedBaseline(task)!;
      const result = await runCompletionGate({ task, baseline, state_path: null,
        env: new NodeExecutionEnv({ cwd: workspace }), context: BACKGROUND_CONTEXT });
      assert.equal(result.exit_code, 0);
      assert.equal(result.workspace_changed, false);
      assert.equal(result.protected_after[0]?.path, baseline[0]!.path);
      assert.equal(result.protected_after.length, 1);
      assert.equal(result.passed, false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
}

test("CompletionGate rejects a missing workspace instead of treating an incomplete scan as unchanged", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-digest-error-"));
  const task = contract(workspace, "process.exit(0)");
  rmSync(workspace, { recursive: true, force: true });
  await assert.rejects(runCompletionGate({ task, baseline: [], state_path: null,
    env: new NodeExecutionEnv({ cwd: workspace }), context: BACKGROUND_CONTEXT }), /ENOENT/);
});

test("workspaceDigest rejects an unreadable file rather than returning a partial digest", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-digest-read-error-"));
  const file = join(workspace, "source-05-locked.ts");
  writeFileSync(file, "must be read");
  // A denied file among readable siblings must still reject the whole scan.
  for (let i = 0; i < 17; i++) writeFileSync(join(workspace, `source-${i}.ts`), "readable sibling");
  try {
    if (process.platform === "win32") {
      // A real exclusive Windows handle denies reads without changing machine ACLs.
      const child = spawn("powershell.exe", ["-NoProfile", "-Command",
        "$f=[System.IO.File]::Open($env:DIGEST_LOCK_FILE, 'Open', 'ReadWrite', 'None'); Write-Output 'locked'; [Console]::ReadLine() | Out-Null; $f.Dispose()"],
      { env: { ...process.env, DIGEST_LOCK_FILE: file }, stdio: ["pipe", "pipe", "pipe"] });
      try {
        const [ready] = await once(child.stdout, "data");
        assert.match(String(ready), /locked/);
        await assert.rejects(workspaceDigest(workspace, null), /EBUSY|EACCES|EPERM/);
        const task = contract(workspace, "process.exit(0)");
        await assert.rejects(runCompletionGate({ task, baseline: [], state_path: null,
          env: new NodeExecutionEnv({ cwd: workspace }), context: BACKGROUND_CONTEXT }), /EBUSY|EACCES|EPERM/);
      } finally {
        child.stdin.end("release\n");
        await once(child, "exit");
      }
    } else {
      if (process.getuid?.() === 0) return t.skip("root can read mode-000 files");
      chmodSync(file, 0);
      await assert.rejects(workspaceDigest(workspace, null), /EACCES/);
    }
  } finally {
    chmodSync(file, 0o600);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("workspaceDigest ignores real audit publication without ignoring project files", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-digest-real-audit-"));
  const db = join(workspace, "state.sqlite");
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "faux-model", name: "Faux" }] });
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("local audit fixture")]);
  try {
    const task = contract(workspace, "process.exit(0)");
    task.limits.max_worker_turns = 1;
    const host = await Host.open({ storage: await openNodeSqliteStorage(db), db_path: db,
      models, model: { provider: "faux", modelId: "faux-model" }, contract: task,
      judge: new FixtureJudge([{ action: "CONTINUE", reason: "fixture", evidence_ids: [], next_message: "continue", external: null }]) });
    try {
      await host.start();
      await host.waitForIdle();
    } finally {
      await host.close();
    }
    const before = await workspaceDigest(workspace, db);
    const projection = await writeAudit(db);
    assert.equal(projection.audit.task_id, "digest-task");
    assert.equal(await workspaceDigest(workspace, db), before);
    await writeAudit(db);
    assert.equal(await workspaceDigest(workspace, db), before);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("workspaceDigest is stable across creation order and frames delimiter-like names and binary content", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-digest-order-"));
  try {
    const files: [string, Buffer][] = [["Z.ts", Buffer.from([0, 10, 255])], ['a[link,].ts', Buffer.alloc(150_000, 1)], ["other.ts", Buffer.from("link:directory\nfile")]];
    for (const [name, bytes] of files) writeFileSync(join(workspace, name), bytes);
    const before = await workspaceDigest(workspace, null);
    for (const [name] of files) rmSync(join(workspace, name));
    for (const [name, bytes] of files.toReversed()) writeFileSync(join(workspace, name), bytes);
    assert.equal(await workspaceDigest(workspace, null), before);
    // Same bytes, different write sizes; stream chunking must not affect identity.
    writeFileSync(join(workspace, "a[link,].ts"), Buffer.alloc(150_000, 1));
    assert.equal(await workspaceDigest(workspace, null), before);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("workspaceDigest records junction/link identity without traversing external contents", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-digest-link-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-nf-digest-outside-"));
  try {
    const link = join(workspace, "linked-project");
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    const before = await workspaceDigest(workspace, null);
    writeFileSync(join(outside, "external.ts"), "not implicitly authorized");
    assert.equal(await workspaceDigest(workspace, null), before);
    rmSync(link);
    mkdirSync(link);
    assert.notEqual(await workspaceDigest(workspace, null), before);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("workspaceDigest excludes only known dependency/cache metadata while retaining adjacent source", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-digest-caches-"));
  try {
    nestedRepositories(workspace);
    const before = await workspaceDigest(workspace, null);
    for (const [directory, marker] of [["node_modules", ".package-lock.json"], [".venv", "pyvenv.cfg"], ["venv", "pyvenv.cfg"], [".pytest_cache", "CACHEDIR.TAG"], [".ruff_cache", "CACHEDIR.TAG"], [".mypy_cache", "CACHEDIR.TAG"]]) {
      const path = join(workspace, "alpha", directory!);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, marker!), marker === "CACHEDIR.TAG" ? "Signature: 8a477f597d28d172789f06886806bc55\n" : "generated marker");
      writeFileSync(join(path, "generated"), "cache changed");
    }
    assert.equal(await workspaceDigest(workspace, null), before);
    writeFileSync(join(workspace, "beta", ".coverage-config.ts"), "source, not coverage data");
    assert.notEqual(await workspaceDigest(workspace, null), before);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

// Approved seams: workspaceDigest and CompletionGate; real files and verifier processes.
test("CompletionGate ignores its own audit projection and explicit state writes", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-digest-audit-"));
  try {
    const directory = join(workspace, ".pi-nf", "digest-task");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "audit.json"), '{"generated_at":"before"}');
    const task = contract(workspace, `
      const fs = require('node:fs');
      fs.writeFileSync('.pi-nf/digest-task/audit.json.123.tmp', '{"generated_at":"after"}');
      fs.renameSync('.pi-nf/digest-task/audit.json.123.tmp', '.pi-nf/digest-task/audit.json');
      fs.writeFileSync('state.sqlite', 'state');
      fs.writeFileSync('state.sqlite-wal', 'wal');
      fs.writeFileSync('state.sqlite-shm', 'shm');
    `);
    const result = await runCompletionGate({ task, baseline: [], state_path: join(workspace, "state.sqlite"),
      env: new NodeExecutionEnv({ cwd: workspace }), context: BACKGROUND_CONTEXT });
    assert.equal(result.exit_code, 0);
    assert.equal(result.workspace_changed, false);
    assert.equal(result.passed, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
