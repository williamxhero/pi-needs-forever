# pi-nf

pi-nf is the first durable implementation of **Needs Forever** supervision on top of
[`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable).
It is a standalone durable host. It also ships an optional Pi extension command,
`/needs-forever`, which launches a pi-nf handoff task and leaves the current Pi
session as a launcher/observer.

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
- `pause` persists PAUSED before canceling owned work. `resume` opens a new task version, preserves the contract/artifacts/baseline/counters, and does not replay old directions. Explicit `INTERRUPTED` recovery is required after restart-limit interruption.
- Cumulative `max_worker_turns`/`max_minutes`/`max_tokens`/`max_cost` limits pause with `user_limit` before the next direction. Judge tokens/cost are tracked; A's conversation usage is not yet included.
- CLI `pause`/`resume`/`web` and a local read-only web status page are available.

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

- **Full provider/auth recovery classification**: judge transport failures become INTERRUPTED; authentication/quota-specific RECOVERING treatment is not yet distinguished.
- **Full task-graph UI**: the built-in web page is a read-only status projection, not the complete NFG interaction surface.
- **Provider/API probing**: C2 currently grounds local workspace artifacts and observed failures. It does not make arbitrary network calls or prove provider authorization/quota.
- Migrating old Codex `state.json`, thread IDs or event logs.

## Pi command `/needs-forever`

Build the package, then install its local Pi package entry:

```bash
npm run build
pi install D:/Pi/pi-nf/pi-nf
```

The command creates a **new A session** (a pi-nf handoff). The current Pi session
does not become A and does not receive the new A's transcript. It is the launcher
and observer; NFG is the live display.

```text
/needs-forever 454                 preview the issue contract; does not start
/needs-forever 454 --dry-run       explicit preview only
/needs-forever 454 --yes           start after reviewing a complete preview
/needs-forever 454 --contract task.json
/needs-forever 454 --restart       recover a dead handoff explicitly
/needs-forever status [454]        show one handoff receipt, or all of them
/needs-forever help
```

Issue resolution uses the current repository's GitHub `origin`, the issue's
markdown acceptance checklist, and a project `.needs-forever.json` (or
`needs-forever.json`) for authorization and the fixed-argv verifier. See
[`examples/needs-forever.json`](examples/needs-forever.json). A prose-only issue
is only a draft: the command refuses to start until the contract has explicit
acceptance, authorization and an independent verifier. `--yes` cannot bypass a
gap.

Receipts, canonical contracts and logs are stored under `~/.pi-nf` (override with
`PI_NF_HOME`), outside the task workspace. A receipt also records whether the NFG
projection existed at handshake time (`NFG visible`), so "started" is never reported
as "visible". The same module is available without
Pi:

```bash
node dist/src/cli.js needs --issue 454 --dry-run
node dist/src/cli.js needs --issue 454 --yes
node dist/src/cli.js needs status --issue 454
node dist/src/cli.js needs status            # list every receipt
node dist/src/cli.js recover --db ~/.pi-nf/tasks/owner-repo/454/state.sqlite
```

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

# Control a task when no other writer holds its lease.
node dist/src/cli.js pause --db data/task.sqlite
node dist/src/cli.js resume --db data/task.sqlite

# Local read-only status page.
node dist/src/cli.js web --db data/task.sqlite --port 8787
```

The default model is `opencode-go/deepseek-v4.1-flash`. The CLI reads
`OPENCODE_API_KEY` or the `opencode-go` key from `~/.pi/agent/auth.json`. Override
the worker with `--model provider/modelId` and the judge with
`--judge-model provider/modelId`; the judge may use a different provider or model
from the worker.

## NFG display projection

`start`, `send`, `pause` and `resume` also maintain a read-only projection for
**NFG** (Needs Forever GUI) at `<workspace>/.pi-nf/<task_id>/audit.json`, refreshed
at most once per second while the CLI writer runs. It is computed from committed
documents and entries, is never read back by pi-nf, and never changes task state.
`--no-nfg` disables it; `--out <directory>` publishes it under another root.

```bash
# Rebuild the projection from committed state (read-only database access).
node dist/src/cli.js audit --db data/task.sqlite
node dist/src/cli.js audit --db data/task.sqlite --out D:/work/example --json
```

NFG (in the `needs-forever` repository, `src/NFG/pi-nf.ts`) discovers
`.pi-nf/*/audit.json` in each workspace it already catalogs. The projection is
`schema_version: 2` with a bounded, redacted transcript of A's assistant text,
thinking, tool calls/results, B directions, C decisions and verification. NFG
renders a two-column read-only workspace for those tasks: live conversation on
the left and the existing stage/round/route/verification view on the right.
v1 projections and Codex tasks keep the old single-column view.

The transcript window is replaced on each poll; stable item IDs make refreshes
idempotent. `window.has_more` means older items were omitted. Thinking is
collapsed by default and can be disabled with `audit --no-thinking` or
`writeAudit({ includeThinking: false })`; content is redacted and bounded before
it reaches disk.

pi-nf tasks are read-only in NFG: pause/resume/delete stay with this CLI because
they need the pi-nf writer lease. A round shows a received direction only when
the durable submission was `placed` or `done`; a committed direction that never
reached A stays visibly undelivered. Register the task workspace as an NFG
workspace so the projection is discoverable.

## Limits, pause and recovery

`limits` accepts `max_worker_turns`, `max_minutes`, `max_tokens` and `max_cost`; `null` means no limit. Limits are checked before a CONTINUE direction is sent. A hit persists `PAUSED/user_limit` and does not send the next round. `max_tokens`/`max_cost` currently account for judge usage, not worker A's conversation usage.

`pause` writes PAUSED before canceling owned judge/verify tasks. Late results cannot overwrite PAUSED. `resume` increments the task version and input epoch, keeps the contract/artifacts/verifier baseline/cumulative counters, clears pending delivery state, and submits a fresh resume input. It does not replay an old direction. `INTERRUPTED` requires an explicit resume.

The `start`, `send`, `pause` and `resume` CLI commands are one-shot writers: only one may hold the task lease at a time. `status` and `web` open SQLite read-only and can run beside a writer. The web page never mutates state or uploads task content.

## Durability model

- State lives in the SQLite database passed to `--db`.
- A writable host holds an exclusive lease keyed by task ID and canonical workspace. `status` does not take that lease.
- A stale lease is reclaimed only after the recorded PID is proven absent; no saved PID is killed.
- `nf.judge` and `nf.direction` are durable tasks/entries. Reopening the same database resumes unfinished work; a committed direction is not sent twice.
- `send` and `start` are one-shot CLI operations. Only one writer may open a task at a time.

## Testing boundary

`npm test` exercises the host seam (`start` / `send` / `pause` / `resume` / `status` / `web` / durable docs / task graph) with a faux worker and judge. Verification subprocesses are real local processes; C2 routes, lifecycle and the read-only web projection are included. The suite does not claim live model or provider acceptance. The design and migration context are in:

- [`docs/design/pi-nf-modules.md`](../docs/design/pi-nf-modules.md)
- [`docs/design/pi-nf-architecture.html`](../docs/design/pi-nf-architecture.html)
- [`MIGRATION.md`](../MIGRATION.md)
- SPEC #1: https://github.com/williamxhero/pi-needs-forever/issues/1
