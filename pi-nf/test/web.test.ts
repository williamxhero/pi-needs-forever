import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Host } from "../src/host.js";
import { startWebServer } from "../src/web.js";

test("web exposes committed status read-only", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-web-"));
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
      task_id: "web-task",
      workspace,
      goal: "web",
      acceptance: [{ id: "A1", text: "web" }],
      authorization: "local",
      c2: { mode: "legacy" },
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
  const server = await startWebServer({ db_path: db, port: 0 });
  try {
    const response = await fetch(new URL("api/status", server.url));
    assert.equal(response.status, 200);
    const status = await response.json() as { task_id: string; status: string };
    assert.equal(status.task_id, "web-task");
    assert.equal(status.status, "ACTIVE");
    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /pi-nf/);
    const missing = await fetch(new URL("nope", server.url));
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
