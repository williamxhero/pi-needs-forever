import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  MemoryStorage,
  ROOT_CONVERSATION_ID,
  type ModelRef,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Host } from "../src/host.js";
import { NfContract, NfControl, NfVerify } from "../src/docs.js";
import { LeaseHeldError } from "../src/types.js";

const MODEL: ModelRef = { provider: "faux", modelId: "faux-model" };

function fakeModels(response = "Started."): Models {
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "faux-model", name: "Faux Model" }] });
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage(response)]);
  return models;
}

function contract(workspace: string, taskId = "task-1"): Record<string, unknown> {
  return {
    schema_version: 1,
    task_id: taskId,
    workspace,
    goal: "Implement the requested feature",
    acceptance: [{ id: "A1", text: "The feature works" }],
    authorization: "Only edit this workspace",
    limits: { max_worker_turns: null, max_minutes: null },
  };
}

test("start persists the contract/control docs, creates A, and submits the initial goal", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-host-"));
  const dbPath = join(workspace, "state.sqlite");
  const host = await Host.open({
    storage: new MemoryStorage(),
    models: fakeModels(),
    model: MODEL,
    contract: contract(workspace),
    db_path: dbPath,
  });
  try {
    const receipt = await host.start("Begin the task.");
    await host.waitForIdle();
    const status = await host.inspect();
    assert.equal(receipt.task_id, "task-1");
    assert.equal(receipt.task_version, 1);
    assert.equal(status.task_id, "task-1");
    assert.equal(status.status, "ACTIVE");
    assert.equal(status.task_version, 1);
    assert.ok(receipt.submission_id.length > 0);

    const contractDoc = await host.harness.snapshot(NfContract, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.equal(contractDoc?.status, "ready");
    assert.equal(contractDoc?.task?.goal, "Implement the requested feature");
    assert.equal(contractDoc?.task?.acceptance.length, 1);

    const control = await host.harness.snapshot(NfControl, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.equal(control?.status, "ACTIVE");
    assert.equal(control?.task_version, 1);
    assert.equal(control?.input_epoch, 0);

    const conversation = await host.harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
    assert.ok(conversation);
    const agent = await conversation.agent(BACKGROUND_CONTEXT);
    const section = agent.sections.find((entry) => entry.key === "nf-contract");
    assert.ok(section, "the contract prompt section is installed");
    const rendered = await section.render(
      {
        conversationId: conversation.id,
        agent,
        env: undefined,
        shown: {},
        read: host.harness,
      },
      BACKGROUND_CONTEXT,
    );
    assert.match(rendered ?? "", /Implement the requested feature/);
    assert.match(rendered ?? "", /A1: The feature works/);
    assert.match(rendered ?? "", /Only edit this workspace/);

    const entries = await conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
    assert.ok(entries.items.some((entry) => entry.kind === "pi.user"));
    assert.ok(entries.items.some((entry) => entry.kind === "pi.assistant"));
  } finally {
    await host.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a second writer for the same task is rejected by the lease", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-lease-"));
  const dbPath = join(workspace, "state.sqlite");
  const first = await Host.open({
    storage: new MemoryStorage(),
    models: fakeModels(),
    model: MODEL,
    contract: contract(workspace, "lease-task"),
    db_path: dbPath,
  });
  try {
    await assert.rejects(
      Host.open({
        storage: new MemoryStorage(),
        models: fakeModels(),
        model: MODEL,
        contract: contract(workspace, "lease-task"),
        db_path: dbPath,
      }),
      LeaseHeldError,
    );
  } finally {
    await first.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("starting the same task twice is rejected", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-twice-"));
  const host = await Host.open({
    storage: new MemoryStorage(),
    models: fakeModels(),
    model: MODEL,
    contract: contract(workspace, "twice-task"),
    db_path: join(workspace, "state.sqlite"),
  });
  try {
    await host.start();
    await assert.rejects(host.start());
  } finally {
    await host.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("status reads committed state from SQLite without taking the writer lease", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-status-"));
  const dbPath = join(workspace, "state.sqlite");
  const storage = await openNodeSqliteStorage(dbPath);
  const host = await Host.open({
    storage,
    models: fakeModels(),
    model: MODEL,
    contract: contract(workspace, "status-task"),
    db_path: dbPath,
  });
  try {
    await host.start();
    await host.waitForIdle();
  } finally {
    await host.close();
  }
  try {
    const status = await Host.status(dbPath);
    assert.equal(status.task_id, "status-task");
    assert.equal(status.status, "ACTIVE");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a verifier contract records a protected baseline before the first run", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-baseline-"));
  try {
    const protectedPath = join(workspace, "verify.mjs");
    writeFileSync(protectedPath, "console.log('ok');\n");
    const task = {
      ...contract(workspace, "baseline-task"),
      verify: {
        argv: [process.execPath, protectedPath],
        timeout_seconds: 10,
        protected_files: ["verify.mjs"],
      },
    };
    const host = await Host.open({
      storage: new MemoryStorage(),
      models: fakeModels(),
      model: MODEL,
      contract: task,
      db_path: join(workspace, "state.sqlite"),
    });
    try {
      await host.start();
      const status = await host.inspect();
      assert.equal(status.verification.configured, true);
      assert.equal(status.verification.baseline_count, 1);
      assert.equal(status.verification.state, "ready");
      const verify = await host.harness.snapshot(NfVerify, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
      assert.equal(verify?.baseline?.length, 1);
      assert.equal(verify?.baseline?.[0]?.path, protectedPath);
      assert.match(verify?.baseline?.[0]?.sha256 ?? "", /^[0-9a-f]{64}$/);
    } finally {
      await host.close();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a missing or escaping protected file fails start before any run", async () => {
  const parent = mkdtempSync(join(tmpdir(), "pi-nf-baseline-escape-"));
  const workspace = join(parent, "workspace");
  mkdirSync(workspace);
  const outside = join(parent, "outside.txt");
  writeFileSync(outside, "outside");
  try {
    for (const file of ["missing.txt", "../outside.txt", outside]) {
      const task = {
        ...contract(workspace, `baseline-${file}`),
        verify: {
          argv: [process.execPath, "verify.mjs"],
          timeout_seconds: 10,
          protected_files: [file],
        },
      };
      const host = await Host.open({
        storage: new MemoryStorage(),
        models: fakeModels(),
        model: MODEL,
        contract: task,
        db_path: join(parent, "state.sqlite"),
      });
      try {
        await assert.rejects(host.start(), /protected file/);
      } finally {
        await host.close();
      }
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
