import { defineDoc, defineEntry } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord/json";
import type {
  ControlPhase,
  ControlStatus,
  DecisionSummary,
  DeliveryState,
  TaskContract,
} from "./types.js";

export type ContractDoc = {
  schema_version: 1;
  status: "unset" | "ready";
  task: TaskContract | null;
  contract_sha256: string;
  prepared_at: string | null;
};

export const NfContract = defineDoc<ContractDoc>({
  kind: "nf.contract",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    schema_version: 1,
    status: "unset",
    task: null,
    contract_sha256: "",
    prepared_at: null,
  }),
  checkpointWhen: () => true,
});

export type ControlDoc = {
  schema_version: 1;
  status: ControlStatus;
  phase: ControlPhase;
  task_version: number;
  input_epoch: number;
  worker_turns: number;
  active_seconds: number;
  last_round_id: string | null;
  last_decision: DecisionSummary | null;
  delivery: DeliveryState | null;
  last_error: string | null;
  pause_reason: string | null;
  updated_at: string;
};

export const NfControl = defineDoc<ControlDoc>({
  kind: "nf.control",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    schema_version: 1,
    status: "ACTIVE",
    phase: "IDLE",
    task_version: 1,
    input_epoch: 0,
    worker_turns: 0,
    active_seconds: 0,
    last_round_id: null,
    last_decision: null,
    delivery: null,
    last_error: null,
    pause_reason: null,
    updated_at: "",
  }),
  checkpointWhen: () => true,
});

export type RoundDoc = {
  schema_version: 1;
  round_id: string;
  run: {
    first: number;
    answer: number;
    last: number;
  } | null;
  status: "open" | "decided" | "superseded" | "interrupted";
  decision: JsonValue | null;
  snapshot_id: string | null;
  evidence_count: number;
  created_at: string;
  updated_at: string;
};

export const NfRound = defineDoc<RoundDoc>({
  kind: "nf.round",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    schema_version: 1,
    round_id: "",
    run: null,
    status: "open",
    decision: null,
    snapshot_id: null,
    evidence_count: 0,
    created_at: "",
    updated_at: "",
  }),
  checkpointWhen: () => true,
});

export type NfEventData = {
  type: string;
  at: string;
  details?: JsonValue;
};

export const NfEvent = defineEntry<NfEventData>("nf.event");
