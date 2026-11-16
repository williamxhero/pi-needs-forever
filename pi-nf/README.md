# pi-nf

pi-nf is the first durable implementation of **Needs Forever** supervision on top of
[`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable).
It is a standalone host, not a Codex plugin and not a Pi coding-agent extension.

## What works in this build (SPEC 1)

- One durable SQLite Harness per task.
- Contract validation, normalization, hashing and durable storage.
- Worker A is a root conversation with the normal coding tools and a contract prompt.
- Every answered run creates one `nf.judge` child task; the run stays busy while judging.
- Evidence is built from real transcript entries and tool results. Assistant text is context, never independent completion evidence.
- Judge C is a tool-free model call (`ModelJudge`) or a deterministic fixture in tests. It returns `CONTINUE`, `DONE` or `WAIT_EXTERNAL` as one strict JSON object.
- `CONTINUE` is delivered as one `nf.direction` entry and one deterministic submission (`requestId`); the decision and submission are committed together.
- Human input increments an `input_epoch`; a direction that becomes stale during judging is marked superseded and is not delivered.
- A killed host can reopen the same SQLite database, reclaim a stale lease, resume `nf.judge`, and avoid duplicating a committed direction.
- `status` is a read-only projection; `send` is a one-shot human input path when no writer holds the lease. `send` rejects DONE and INTERRUPTED until an explicit resume exists.
- Contracts may configure a fixed-argv verifier with protected files. DONE waits for `nf.verify`; a failed gate returns a repair CONTINUE with the actual evidence.
- C2 enforcement is the default: CONTINUE carries a diagnosis and a route plan. Local workspace artifacts are discovered by B and recorded in a route catalog; a route ledger rejects a third equivalent no-progress attempt. WAIT_EXTERNAL requires every observed route to be attempted or excluded with evidence.

## C2 routes

`c2.mode` defaults to `enforce`. A CONTINUE must carry a diagnosis and a route plan with one selected route and its concrete actions. When more than one executable route exists, at least two materially different candidates are required; a single route needs `single_route_reason`.

B discovers bounded local workspace artifacts at start (up to four non-secret files, 16 KiB each) and records provenance, digest evidence and authorization in a durable catalog. Candidate route wording never proves availability; observed routes need catalog evidence. B reads inventory hints independently and never treats a hint as permission or availability.

Each delivered route is recorded in a durable ledger. A next round captures the actual outcome; a third equivalent resource/operation attempt is rejected, and a second same-family failure needs a new hypothesis or discriminating check. Missing facts require a bounded inventory CONTINUE. `WAIT_EXTERNAL` is accepted only when every catalog route has a current attempted/excluded proof and a specific resume condition.

## Verification gate

A contract may configure a fixed argv verifier and protected files:

```json
"verify": {
  "argv": ["node", "verify.mjs"],
  "timeout_seconds": 120,
  "protected_files": ["verify.mjs", "test/acceptance.test.js"]
}
```

At `start`, pi-nf records each protected file's SHA-256 and original content before A's first run. When C returns DONE, `nf.verify` runs the argv directly through the task's `ExecutionEnv` (no shell), checks protected files and a workspace digest before/after, and only then allows DONE. A changed protected file, a verifier failure/timeout, or a workspace change during verification becomes a repair CONTINUE with the actual evidence and original protected content. Missing protected files fail `start`; a partial baseline is never treated as a pass.

`argv` should use an absolute executable or a command available on the execution environment's PATH. `timeout_seconds` is passed to the environment as seconds. The local `NodeExecutionEnv` is a cooperative process boundary, not an OS sandbox.

## Not in this build

These are later SPECs, not hidden behavior:

- **Pause/resume, cumulative limits, crash-loop interruption, web UI** (SPEC 4): limits are stored but not enforced yet; pause/resume is not exposed.
- **Provider/API probing**: C2 currently grounds local workspace artifacts and observed failures. It does not make arbitrary network calls or prove provider authorization/quota.
- Migrating old Codex `state.json`, thread IDs or event logs.

## Install and test

Requires Node.js 24 or newer.

```bash
cd pi-nf
npm ci --ignore-scripts
npm run build
npm test
```

The test suite uses pi-ai's faux provider and local subprocesses. It does not require a live model. The crash tests spawn a real child host, kill it at snapshot/judge/delivery boundaries, and reopen SQLite.

## Contract

Copy and edit `examples/task.json`. `workspace` must be an absolute path to an existing directory. `acceptance` must contain at least one unique nonempty item. `authorization` is required.

```json
{
  "schema_version": 1,
  "task_id": "example-task",
  "workspace": "C:/absolute/path/to/your/workspace",
  "goal": "What should be true when the task is done",
  "acceptance": [{ "id": "A1", "text": "A verifiable acceptance item" }],
  "authorization": "Only modify this workspace",
  "c2": { "mode": "legacy" },
  "limits": { "max_worker_turns": null, "max_minutes": null }
}
```

## Run

```bash
# Start a task, supervise the first run, and close when it becomes idle.
node dist/src/cli.js start --task examples/task.json --db data/task.sqlite \
  --model opencode-go/deepseek-v4.1-flash

# Read committed state without taking the writer lease.
node dist/src/cli.js status --db data/task.sqlite
node dist/src/cli.js status --db data/task.sqlite --json

# One-shot human input when no other writer holds the task lease.
node dist/src/cli.js send --db data/task.sqlite --message "Please continue with the next step."
```

The default model is `opencode-go/deepseek-v4.1-flash`. The CLI reads
`OPENCODE_API_KEY` or the `opencode-go` key from `~/.pi/agent/auth.json`. Override
the worker with `--model provider/modelId` and the judge with
`--judge-model provider/modelId`; the judge may use a different provider or model
from the worker.

## Durability model

- State lives in the SQLite database passed to `--db`.
- A writable host holds an exclusive lease keyed by task ID and canonical workspace. `status` does not take that lease.
- A stale lease is reclaimed only after the recorded PID is proven absent; no saved PID is killed.
- `nf.judge` and `nf.direction` are durable tasks/entries. Reopening the same database resumes unfinished work; a committed direction is not sent twice.
- `send` and `start` are one-shot CLI operations. Only one writer may open a task at a time.

## Testing boundary

`npm test` exercises the host seam (`start` / `send` / `status` / durable docs / task graph) with a faux worker and judge. Verification subprocesses are real local processes; C2 routes, pause/resume and the web UI are intentionally absent from this build. The design and migration context are in:

- [`docs/design/pi-nf-modules.md`](../docs/design/pi-nf-modules.md)
- [`docs/design/pi-nf-architecture.html`](../docs/design/pi-nf-architecture.html)
- [`MIGRATION.md`](../MIGRATION.md)
- SPEC #1: https://github.com/williamxhero/pi-needs-forever/issues/1
