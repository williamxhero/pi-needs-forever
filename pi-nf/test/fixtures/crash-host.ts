import { writeFileSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ModelRef } from "@earendil-works/pi-durable";
import { readContractFile } from "../../src/contract.js";
import { EvidenceBuilder, type BuildEvidenceInput, type EvidenceSnapshot } from "../../src/evidence.js";
import { Host } from "../../src/host.js";
import type { Judge } from "../../src/judge.js";

const db = process.env.NF_DB!;
const taskPath = process.env.NF_TASK!;
const marker = process.env.NF_MARKER!;
const mode = process.env.NF_MODE as "snapshot" | "judge" | "delivery" | "verify";
const model: ModelRef = { provider: "faux", modelId: "faux-model" };

class BlockingEvidence extends EvidenceBuilder {
  override async build(_input: BuildEvidenceInput): Promise<EvidenceSnapshot> {
    writeFileSync(marker, "snapshot");
    return new Promise<never>(() => {});
  }
}

const blockingJudge: Judge = {
  async decide() {
    writeFileSync(marker, "judge");
    return new Promise<never>(() => {});
  },
};

const doneJudge: Judge = {
  async decide(snapshot) {
    const evidence = snapshot.evidence[0];
    if (!evidence) throw new Error("crash fixture verifier has no evidence");
    return {
      action: "DONE",
      reason: "crash fixture verification evidence",
      evidence_ids: [evidence.id],
      next_message: "",
      external: null,
    };
  },
};

const continueJudge: Judge = {
  async decide() {
    return {
      action: "CONTINUE",
      reason: "crash fixture continuation",
      evidence_ids: [],
      next_message: "Continue after recovery.",
      external: null,
    };
  },
};

const models = createModels();
const faux = fauxProvider({ models: [{ id: "faux-model", name: "Faux Model" }] });
models.setProvider(faux.provider);
faux.setResponses(mode === "verify" ? [
  fauxAssistantMessage([fauxToolCall("bash", { command: "echo evidence" })], { stopReason: "toolUse" }),
  fauxAssistantMessage("Verification answer."),
] : [
  fauxAssistantMessage("First answer."),
  fauxAssistantMessage([fauxToolCall("bash", { command: "echo resumed" })], { stopReason: "toolUse" }),
  fauxAssistantMessage("Second answer."),
  fauxAssistantMessage("Third answer."),
]);

const storage = await openNodeSqliteStorage(db);
const host = await Host.open({
  storage,
  models,
  model,
  contract: readContractFile(taskPath),
  db_path: db,
  judge: mode === "delivery" ? continueJudge : mode === "verify" ? doneJudge : blockingJudge,
  ...(mode === "snapshot" ? { evidence: new BlockingEvidence() } : {}),
  context: BACKGROUND_CONTEXT,
});
await host.start();
// Keep the child alive; the parent polls the marker or the database and kills it.
setInterval(() => {}, 60_000);
await new Promise<never>(() => {});
