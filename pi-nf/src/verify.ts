import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ProtectedBaseline, TaskContract } from "./types.js";
import { ContractError } from "./types.js";

function inside(workspace: string, path: string): boolean {
  const suffix = relative(workspace, path);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
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

export function protectedChanges(baseline: readonly ProtectedBaseline[]): { path: string; expected_sha256: string; actual_sha256: string | null }[] {
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
