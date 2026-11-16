import type { ModelRef } from "@earendil-works/pi-durable";

export type { ModelRef };

export type C2Mode = "enforce" | "shadow" | "legacy";

export type AcceptanceItem = {
  id: string;
  text: string;
};

export type VerifyConfig = {
  argv: string[];
  timeout_seconds: number;
  protected_files: string[];
};

export type TaskLimits = {
  max_worker_turns: number | null;
  max_minutes: number | null;
};

export type TaskContract = {
  schema_version: 1;
  task_id: string;
  workspace: string;
  goal: string;
  acceptance: AcceptanceItem[];
  authorization: string;
  c2?: { mode: C2Mode };
  verify?: VerifyConfig;
  limits: TaskLimits;
};

export type PreparedContract = {
  task: TaskContract;
  contract_sha256: string;
};

export type ControlStatus =
  | "ACTIVE"
  | "JUDGING"
  | "WAIT_EXTERNAL"
  | "PAUSED"
  | "DONE"
  | "INTERRUPTED";

export type ControlPhase =
  | "IDLE"
  | "WORKER"
  | "JUDGE"
  | "VERIFY"
  | "RECOVERING";

export type DeliveryState = {
  stage: "prepared" | "submitted" | "confirmed";
  submission_id?: string;
  direction_entry_id?: string;
  round_id: string;
};

export type DecisionSummary = {
  action: "CONTINUE" | "DONE" | "WAIT_EXTERNAL";
  reason: string;
};

export type SupervisionStatus = {
  task_id: string;
  task_version: number;
  status: ControlStatus;
  phase: ControlPhase;
  input_epoch: number;
  last_round: { round_id: string } | null;
  last_decision: DecisionSummary | null;
  evidence_count: number;
  delivery: DeliveryState | null;
  limits: TaskLimits;
  task_graph: {
    tasks: { id: string; kind: string; status: string }[];
    submissions: { id: string; status: string; conversation_id: string }[];
  };
};

export type StartReceipt = {
  task_id: string;
  task_version: number;
  conversation_id: string;
  submission_id: string;
  status: ControlStatus;
};

export type StartInput = {
  prepared: PreparedContract;
  initial_message?: string;
};

export class ContractError extends Error {
  override name = "ContractError";
}

export class VerifierUnsupportedError extends ContractError {
  override name = "VerifierUnsupportedError";
}

export class LeaseHeldError extends Error {
  override name = "LeaseHeldError";
}

export class AlreadyStartedError extends Error {
  override name = "AlreadyStartedError";
}

export class NotStartedError extends Error {
  override name = "NotStartedError";
}

export type HostStartOptions = {
  contract: TaskContract;
  db_path?: string;
  initial_message?: string;
};

export type HostInspectOptions = {
  context?: import("@earendil-works/chord/context").Context;
};

export type { ModelRef as NfModelRef };
