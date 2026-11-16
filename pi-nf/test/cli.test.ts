import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Host } from "../src/host.js";

test("pi-nf status --json reads committed state without a writer lease", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-cli-"));
  const db = join(workspace, "state.sqlite");
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "faux-model", name: "Faux Model" }] });
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("ok")]);
  const host = await Host.open({
    storage: await openNodeSqliteStorage(db),
    models,
    model: { provider: "faux", modelId: "faux-model" },
    contract: {
      schema_version: 1,
      task_id: "cli-task",
      workspace,
      goal: "CLI status",
      acceptance: [{ id: "A1", text: "status works" }],
      authorization: "local only",
      limits: { max_worker_turns: null, max_minutes: null },
    },
    db_path: db,
  });
  try {
    await host.start();
    await host.waitForIdle();
  } finally {
    await host.close();
  }
  try {
    const output = execFileSync(process.execPath, ["dist/src/cli.js", "status", "--db", db, "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const status = JSON.parse(output) as { task_id: string; status: string };
    assert.equal(status.task_id, "cli-task");
    assert.equal(status.status, "ACTIVE");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
