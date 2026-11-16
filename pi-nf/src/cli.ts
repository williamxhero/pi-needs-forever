#!/usr/bin/env node
import { parseArgs } from "node:util";
import { writeAudit } from "./audit.js";
import { Host } from "./host.js";
import { startWebServer } from "./web.js";
import { createDefaultModels, resolveModelRef } from "./models.js";
import type { SupervisionStatus } from "./types.js";

function printStatus(status: SupervisionStatus): void {
  const lines = [
    `task: ${status.task_id} v${status.task_version}`,
    `status: ${status.status} (${status.phase})`,
    `round: ${status.last_round?.round_id ?? "-"}`,
    `decision: ${status.last_decision ? `${status.last_decision.action}: ${status.last_decision.reason}` : "-"}`,
    `evidence: ${status.evidence_count}`,
    `delivery: ${status.delivery ? `${status.delivery.stage} ${status.delivery.submission_id ?? ""}` : "-"}`,
    `error: ${status.last_error ?? "-"}`,
    `limits: turns=${status.limits.max_worker_turns ?? "none"} minutes=${status.limits.max_minutes ?? "none"}`,
    `tasks: ${status.task_graph.tasks.map((task) => `${task.kind}:${task.status}`).join(", ") || "-"}`,
    `submissions: ${status.task_graph.submissions.map((submission) => `${submission.id.slice(0, 8)}:${submission.status}`).join(", ") || "-"}`,
  ];
  console.log(lines.join("\n"));
}

function usage(): void {
  console.log(`pi-nf — durable Needs Forever supervision

Usage:
  pi-nf start --task <contract.json> --db <state.sqlite> [--model provider/model] [--json]
  pi-nf status --db <state.sqlite> [--json]
  pi-nf send --db <state.sqlite> --message <text> [--request-id <id>] [--model provider/model] [--json]
  pi-nf pause --db <state.sqlite> [--json]
  pi-nf resume --db <state.sqlite> [--model provider/model] [--json]
  pi-nf web --db <state.sqlite> [--port 8787]
  pi-nf audit --db <state.sqlite> [--out <directory>] [--json]

start/send/pause/resume also refresh the read-only NFG projection under
<workspace>/.pi-nf/<task_id>/audit.json unless --no-nfg is set.
`);
}

/**
 * Keep the file-based NFG projection close to committed state while a CLI
 * writer runs. The projection is best effort: a failure never changes task
 * state or the command result.
 */
async function withNfgProjection<T>(
  dbPath: string,
  options: { disabled?: boolean; out?: string | undefined },
  run: () => Promise<T>,
): Promise<T> {
  if (options.disabled) return run();
  let flushing = false;
  const flush = async (): Promise<void> => {
    if (flushing) return;
    flushing = true;
    try {
      await writeAudit(dbPath, options.out ? { root: options.out } : {});
    } catch {
      // The projection is a display artifact; authoritative state is the database.
    } finally {
      flushing = false;
    }
  };
  await flush();
  const timer = setInterval(() => { void flush(); }, 1_000);
  timer.unref();
  try {
    return await run();
  } finally {
    clearInterval(timer);
    await flush();
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      task: { type: "string" },
      db: { type: "string" },
      model: { type: "string" },
      "judge-model": { type: "string" },
      message: { type: "string" },
      "request-id": { type: "string" },
      port: { type: "string" },
      out: { type: "string" },
      "no-nfg": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    usage();
    return values.help ? 0 : 2;
  }
  if (command === "status") {
    if (!values.db) throw new Error("status requires --db <state.sqlite>");
    const status = await Host.status(values.db);
    if (values.json) console.log(JSON.stringify(status, null, 2));
    else printStatus(status);
    return 0;
  }
  if (command === "audit") {
    if (!values.db) throw new Error("audit requires --db <state.sqlite>");
    const result = await writeAudit(values.db, values.out ? { root: values.out } : {});
    if (values.json) console.log(JSON.stringify(result.audit, null, 2));
    else console.log(`wrote ${result.path}`);
    return 0;
  }
  if (command === "web") {
    if (!values.db) throw new Error("web requires --db <state.sqlite>");
    const port = values.port ? Number(values.port) : 8787;
    const server = await startWebServer({ db_path: values.db, port });
    console.log(`pi-nf web: ${server.url}`);
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    await server.close();
    return 0;
  }
  if (command === "pause" || command === "resume") {
    if (!values.db) throw new Error(`${command} requires --db <state.sqlite>`);
    const db = values.db;
    const models = createDefaultModels();
    const model = resolveModelRef(values.model);
    const host = await Host.openExisting(db, { models, model });
    try {
      await withNfgProjection(db, { disabled: values["no-nfg"], out: values.out }, async () => {
        const status = command === "pause" ? await host.pause() : await host.resume();
        if (command === "resume") await host.waitForIdle();
        const finalStatus = command === "resume" ? await host.inspect() : status;
        if (values.json) console.log(JSON.stringify(finalStatus, null, 2));
        else printStatus(finalStatus);
      });
    } finally {
      await host.close();
    }
    return 0;
  }
  if (command === "send") {
    if (!values.db) throw new Error("send requires --db <state.sqlite>");
    if (!values.message || !values.message.trim()) throw new Error("send requires --message <text>");
    const db = values.db;
    const message = values.message;
    const requestId = values["request-id"];
    const models = createDefaultModels();
    const model = resolveModelRef(values.model);
    const judgeModel = values["judge-model"] ? resolveModelRef(values["judge-model"]) : undefined;
    const host = await Host.openExisting(db, {
      models,
      model,
      ...(judgeModel ? { judge_model: judgeModel } : {}),
    });
    try {
      await withNfgProjection(db, { disabled: values["no-nfg"], out: values.out }, async () => {
        const receipt = await host.send(message, requestId);
        await host.waitForIdle();
        const status = await host.inspect();
        if (values.json) console.log(JSON.stringify({ receipt, status }, null, 2));
        else {
          console.log(`sent input (submission ${receipt.submission_id}, epoch ${receipt.input_epoch})`);
          printStatus(status);
        }
      });
    } finally {
      await host.close();
    }
    return 0;
  }
  if (command === "start") {
    if (!values.task) throw new Error("start requires --task <contract.json>");
    if (!values.db) throw new Error("start requires --db <state.sqlite>");
    const db = values.db;
    const models = createDefaultModels();
    const model = resolveModelRef(values.model);
    const judgeModel = values["judge-model"] ? resolveModelRef(values["judge-model"]) : undefined;
    const host = await Host.openSqlite({
      db_path: db,
      contract_path: values.task,
      models,
      model,
      ...(judgeModel ? { judge_model: judgeModel } : {}),
    });
    try {
      await withNfgProjection(db, { disabled: values["no-nfg"], out: values.out }, async () => {
        const receipt = await host.start();
        await host.waitForIdle();
        const status = await host.inspect();
        if (values.json) console.log(JSON.stringify({ receipt, status }, null, 2));
        else {
          console.log(`started ${receipt.task_id} v${receipt.task_version} (submission ${receipt.submission_id})`);
          printStatus(status);
        }
      });
    } finally {
      await host.close();
    }
    return 0;
  }
  usage();
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
