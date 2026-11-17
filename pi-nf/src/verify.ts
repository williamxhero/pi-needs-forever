import { createHash } from "node:crypto";
import { createReadStream, readFileSync, realpathSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { open, readdir, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { ProtectedBaseline, TaskContract } from "./types.js";
import { ContractError } from "./types.js";
import { redact } from "./redact.js";

function inside(workspace: string, path: string): boolean {
  const suffix = relative(workspace, path);
  const parent = `..${process.platform === "win32" ? "\\" : "/"}`;
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(parent));
}

export function recordProtectedBaseline(task: TaskContract): ProtectedBaseline[] | null {
  const verify = task.verify;
  if (!verify) return null;
  const workspace = realpathSync(task.workspace);
  return verify.protected_files.map((file) => {
    const requested = isAbsolute(file) ? file : resolve(workspace, file);
    let actual: string;
    try {
      actual = realpathSync(requested);
      if (!statSync(actual).isFile()) throw new ContractError(`protected file is not a regular file: ${file}`);
    } catch (error) {
      if (error instanceof ContractError) throw error;
      throw new ContractError(`protected file does not exist or cannot be resolved: ${file}`);
    }
    if (!inside(workspace, actual)) {
      throw new ContractError(`protected file escapes the task workspace: ${file}`);
    }
    const content = readFileSync(actual);
    return {
      path: actual,
      sha256: createHash("sha256").update(content).digest("hex"),
      content_base64: content.toString("base64"),
    };
  });
}

export type ProtectedChange = {
  path: string;
  expected_sha256: string;
  actual_sha256: string | null;
};

export function protectedChanges(baseline: readonly ProtectedBaseline[]): ProtectedChange[] {
  return baseline.flatMap((file) => {
    let actual: string | null = null;
    try {
      actual = createHash("sha256").update(readFileSync(file.path)).digest("hex");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return actual === file.sha256 ? [] : [{ path: file.path, expected_sha256: file.sha256, actual_sha256: actual }];
  });
}

export type VerificationResult = {
  configured: boolean;
  argv: string[];
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  duration_ms: number;
  protected_before: ProtectedChange[];
  protected_after: ProtectedChange[];
  workspace_before: string | null;
  workspace_after: string | null;
  workspace_changed: boolean;
  passed: boolean;
};

export type GateInput = {
  task: TaskContract;
  baseline: readonly ProtectedBaseline[];
  state_path: string | null;
  env: ExecutionEnv;
  context: Context;
};

function nameForRoot(path: string, workspace: string): string {
  return relative(workspace, path).split(sep).join("/");
}

function exclusionCandidate(path: string, workspace: string, statePath: string | null): boolean {
  const name = relative(workspace, path).split(sep).join("/");
  const segment = name.split("/").at(-1)!;
  if (segment === ".git" || name === ".pi-nf") return true;
  if (!statePath) return false;
  const state = resolve(statePath);
  return path === state || path === `${state}-wal` || path === `${state}-shm`;
}

async function isGitMetadata(path: string, entry: Dirent): Promise<boolean> {
  if (entry.isDirectory()) {
    const children = await readdir(path, { withFileTypes: true });
    return children.some((child) => child.name === "HEAD" && child.isFile()) &&
      children.some((child) => child.name === "objects" && child.isDirectory());
  }
  if (entry.isFile()) {
    const handle = await open(path, "r");
    try {
      const prefix = Buffer.alloc(8);
      const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
      return prefix.subarray(0, bytesRead).toString() === "gitdir: ";
    } finally { await handle.close(); }
  }
  return false;
}

export async function workspaceDigest(workspace: string, statePath: string | null): Promise<string> {
  const root = resolve(workspace);
  const hash = createHash("sha256");
  // Generated payload is not hashed, but its directories may contain independent
  // repositories. Discover them sequentially without following links or Git metadata.
  const discover = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = resolve(directory, entry.name);
      if (entry.name === ".git" && await isGitMetadata(path, entry)) continue;
      const children = await readdir(path, { withFileTypes: true });
      const git = children.find((child) => child.name === ".git");
      if (git && await isGitMetadata(resolve(path, ".git"), git)) {
        hash.update(`${JSON.stringify(["directory", nameForRoot(path, root)])}\n`);
        await walk(path);
      } else {
        await discover(path);
      }
    }
  };
  const walk = async (directory: string): Promise<void> => {
    // Code-unit ordering does not depend on the host locale.
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    // At most eight file streams globally: drain this batch before descending.
    // Keep just fixed-size content hashes, never whole files, until ordered commit.
    const pending: { path: string; name: string }[] = [];
    const flush = async (): Promise<void> => {
      const results = await Promise.allSettled(pending.map(async ({ path, name }) => {
        const content = createHash("sha256");
        for await (const chunk of createReadStream(path)) content.update(chunk);
        return `${JSON.stringify(["file", name, content.digest("hex")])}\n`;
      }));
      // allSettled drains every stream even on failure, without an unhandled rejection
      // or returning while sibling reads are still active. Never commit a partial batch.
      for (const result of results) if (result.status === "rejected") throw result.reason;
      for (const result of results) if (result.status === "fulfilled") hash.update(result.value);
      pending.length = 0;
    };
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (exclusionCandidate(path, root, statePath)) {
        if (entry.name === ".git" && await isGitMetadata(path, entry)) continue;
        if (entry.isDirectory() && nameForRoot(path, root) === ".pi-nf") {
          const children = await readdir(path, { withFileTypes: true });
          if (!children.some((child) => child.name === ".git" && (child.isFile() || child.isDirectory()))) {
            await flush();
            await discover(path);
            continue;
          }
        }
        if (statePath && entry.isFile() && [resolve(statePath), `${resolve(statePath)}-wal`, `${resolve(statePath)}-shm`].includes(path)) continue;
      }
      if (entry.isDirectory() && ["node_modules", ".venv", "venv", ".pytest_cache", ".ruff_cache", ".mypy_cache"].includes(entry.name)) {
        const children = await readdir(path, { withFileTypes: true });
        const file = (name: string) => children.some((child) => child.name === name && child.isFile());
        const repo = children.some((child) => child.name === ".git" && (child.isDirectory() || child.isFile()));
        let tagged = false;
        if (!repo && [".pytest_cache", ".ruff_cache", ".mypy_cache"].includes(entry.name) && file("CACHEDIR.TAG")) {
          const handle = await open(resolve(path, "CACHEDIR.TAG"), "r");
          try {
            const signature = Buffer.alloc(43);
            const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
            tagged = signature.subarray(0, bytesRead).toString() === "Signature: 8a477f597d28d172789f06886806bc55";
          } finally { await handle.close(); }
        }
        if (!repo && ((entry.name === "node_modules" && file(".package-lock.json")) ||
          ((entry.name === ".venv" || entry.name === "venv") && file("pyvenv.cfg")) || tagged)) {
          await flush();
          await discover(path);
          continue;
        }
      }
      const name = relative(root, path).split(sep).join("/");
      // JSON tuples frame type, path and payload unambiguously, even for delimiter-like names.
      // Hash file bytes separately so stream chunk boundaries never enter the framing.
      if (entry.isFile()) {
        pending.push({ path, name });
        if (pending.length === 8) await flush();
      } else {
        await flush();
        if (entry.isSymbolicLink()) {
          hash.update(`${JSON.stringify(["link", name, await readlink(path)])}\n`);
        } else if (entry.isDirectory()) {
          hash.update(`${JSON.stringify(["directory", name])}\n`);
          await walk(path);
        } else {
          throw new Error(`Cannot digest unsupported filesystem entry: ${path}`);
        }
      }
    }
    await flush();
  };
  await walk(root);
  return hash.digest("hex");
}

function bounded(value: string, limit = 8_000): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`;
}

const SEPARATOR = String.fromCharCode(10);

export async function runCompletionGate(input: GateInput): Promise<VerificationResult> {
  const verify = input.task.verify;
  if (!verify) {
    return {
      configured: false,
      argv: [],
      exit_code: null,
      stdout: "",
      stderr: "",
      timed_out: false,
      duration_ms: 0,
      protected_before: [],
      protected_after: [],
      workspace_before: null,
      workspace_after: null,
      workspace_changed: false,
      passed: false,
    };
  }
  if (verify.protected_files.length > 0 && input.baseline.length === 0) {
    return {
      configured: true,
      argv: verify.argv,
      exit_code: null,
      stdout: "",
      stderr: "Missing protected baseline for a verifier with protected files.",
      timed_out: false,
      duration_ms: 0,
      protected_before: [],
      protected_after: [],
      workspace_before: null,
      workspace_after: null,
      workspace_changed: false,
      passed: false,
    };
  }

  const protectedBefore = protectedChanges(input.baseline);
  const workspaceBefore = await workspaceDigest(input.task.workspace, input.state_path);
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let timedOut = false;
  let executionError: string | null = null;
  const started = Date.now();
  if (protectedBefore.length === 0) {
    const result = await input.env.exec(
      verify.argv,
      {
        cwd: input.task.workspace,
        timeout: verify.timeout_seconds,
        inheritEnv: true,
        onOutput: (text, _context, info) => {
          if (info.stream === "stdout") stdout += text;
          else stderr += text;
        },
      },
      input.context,
    );
    if (result.ok) exitCode = result.value.exitCode;
    else {
      timedOut = result.error.code === "timeout";
      executionError = result.error.message;
    }
  }
  const duration = Date.now() - started;
  if (executionError) stderr += `${stderr ? SEPARATOR : ""}${executionError}`;
  const protectedAfter = protectedChanges(input.baseline);
  const workspaceAfter = await workspaceDigest(input.task.workspace, input.state_path);
  const workspaceChanged = workspaceBefore !== workspaceAfter;
  const passed =
    protectedBefore.length === 0 &&
    protectedAfter.length === 0 &&
    !workspaceChanged &&
    !timedOut &&
    executionError === null &&
    exitCode === 0;
  return {
    configured: true,
    argv: verify.argv,
    exit_code: exitCode,
    stdout: bounded(String(redact(stdout))),
    stderr: bounded(String(redact(stderr))),
    timed_out: timedOut,
    duration_ms: duration,
    protected_before: protectedBefore,
    protected_after: protectedAfter,
    workspace_before: workspaceBefore,
    workspace_after: workspaceAfter,
    workspace_changed: workspaceChanged,
    passed,
  };
}
