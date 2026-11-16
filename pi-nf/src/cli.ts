#!/usr/bin/env node
import { parseArgs } from "node:util";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Host } from "./host.js";
import { readContractFile } from "./contract.js";
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
`);
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      task: { type: "string" },
      db: { type: "string" },
      model: { type: "string" },
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
  if (command === "start") {
    if (!values.task) throw new Error("start requires --task <contract.json>");
    if (!values.db) throw new Error("start requires --db <state.sqlite>");
    const models = createDefaultModels();
    const model = resolveModelRef(values.model);
    const storage = await openNodeSqliteStorage(values.db);
    const host = await Host.open({
      storage,
      models,
      model,
      contract: readContractFile(values.task),
      db_path: values.db,
    });
    try {
      const receipt = await host.start();
      await host.waitForIdle();
      const status = await host.inspect();
      if (values.json) console.log(JSON.stringify({ receipt, status }, null, 2));
      else {
        console.log(`started ${receipt.task_id} v${receipt.task_version} (submission ${receipt.submission_id})`);
        printStatus(status);
      }
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
