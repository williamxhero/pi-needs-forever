import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type { TaskContract } from "./types.js";
import { LeaseHeldError } from "./types.js";

export type LeaseOwner = {
  pid: number;
  token: string;
  task_id: string;
  state_path: string;
  started_at: string;
};

export function leasePath(task: Pick<TaskContract, "task_id" | "workspace">): string {
  const identity = JSON.stringify([
    process.platform === "win32" ? resolve(task.workspace).toLowerCase() : resolve(task.workspace),
    task.task_id,
  ]);
  const digest = createHash("sha256").update(identity).digest("hex");
  return resolve(tmpdir(), "pi-nf-locks", `${digest}.lock`);
}

export class Lease {
  private released = false;

  private constructor(
    private readonly path: string,
    private readonly token: string,
  ) {}

  static acquire(task: TaskContract, statePath: string): Lease {
    const path = leasePath(task);
    mkdirSync(dirname(path), { recursive: true });
    let fd: number;
    try {
      fd = openSync(path, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        let owner: Partial<LeaseOwner> = {};
        try {
          owner = JSON.parse(readFileSync(path, "utf8")) as Partial<LeaseOwner>;
        } catch {
          // An unreadable lock is still held; never silently replace it.
        }
        throw new LeaseHeldError(
          `pi-nf task ${task.task_id} is already owned${owner.pid ? ` by pid ${owner.pid}` : ""}; refusing a second writer.`,
        );
      }
      throw error;
    }
    const token = randomUUID();
    try {
      writeFileSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          token,
          task_id: task.task_id,
          state_path: statePath,
          started_at: new Date().toISOString(),
        } satisfies LeaseOwner),
      );
    } finally {
      closeSync(fd);
    }
    return new Lease(path, token);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    try {
      const owner = JSON.parse(readFileSync(this.path, "utf8")) as Partial<LeaseOwner>;
      if (owner.token !== this.token) return;
      unlinkSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
