import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { readdir, readFile, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
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

function excluded(path: string, workspace: string, statePath: string | null): boolean {
  const name = relative(workspace, path).replaceAll("\\", "/");
  if (name === ".git" || name.startsWith(".git/") || name === ".pi" || name.startsWith(".pi/")) return true;
  if (name === ".nf" || name.startsWith(".nf/") || name === ".scratch" || name.startsWith(".scratch/")) return true;
  if (name === ".worktrees" || name.startsWith(".worktrees/")) return true;
  if (name === "node_modules" || name.startsWith("node_modules/")) return true;
  if (!statePath) return false;
  const state = resolve(statePath);
  return path === state || path === `${state}-wal` || path === `${state}-shm`;
}

export async function workspaceDigest(workspace: string, statePath: string | null): Promise<string> {
  const root = resolve(workspace);
  const hash = createHash("sha256");
  const walk = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (excluded(path, root, statePath)) continue;
      const name = relative(root, path).replaceAll("\\", "/");
      hash.update(name);
      if (entry.isSymbolicLink()) {
        hash.update(`link:${await readlink(path)}`);
      } else if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        hash.update(await readFile(path));
      }
    }
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
