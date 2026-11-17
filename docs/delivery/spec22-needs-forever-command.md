# SPEC 22 — `/needs-forever` command and NFG live observer

- SPEC: https://github.com/williamxhero/pi-needs-forever/issues/22
- Tickets: #23 (audit v2), #24 (NeedsForever module), #25 (Pi command), #26 (NFG live source), #27 (NFG two-column UI), #28 (cross-repo acceptance and delivery)
- Repositories: `williamxhero/pi-needs-forever` (pi-nf package), `williamxhero/needs-forever` (NFG)

## Delivered

### pi-nf (`williamxhero/pi-needs-forever`)

| Commit | Content |
| --- | --- |
| `00824c7` | `NeedsForever` module, `/needs-forever` Pi command, `pi-nf needs` / `pi-nf recover`, audit v2 transcript |
| `177caaa` | Review fixes: module split along internal seams; `--restart` no longer confirms a new task; receipt records NFG visibility; `status` lists receipts; parser accepts prose and rejects two issue numbers |
| `4a6c2f3` | Review fixes: `preview()` decomposed into resolver functions; one receipt constructor |
| `bc75818` | Merge to `main` |

Modules:

- `pi-nf/src/needs-forever.ts` — the deep module: `preview` / `start` / `inspect` / `list`, receipt store, detached runtime, readiness handshake, live reuse, orphan recovery.
- `pi-nf/src/needs-contract.ts` — internal contract resolution (existing receipt → explicit contract → project config → issue checklist → empty draft) plus gaps.
- `pi-nf/src/needs-paths.ts` — receipt paths, request keys, atomic JSON.
- `pi-nf/src/needs-forever-command.ts` — argument parsing and formatting; the Pi adapter.
- `pi-nf/src/extension.ts` — Pi package entry (`pi.extensions` in `package.json`).
- `pi-nf/src/audit.ts` — `schema_version: 2` projection with a bounded, redacted transcript window.

### NFG (`williamxhero/needs-forever`)

| Commit | Content |
| --- | --- |
| `ae35dd5` | `PiNfAudit` v2, normalized `TaskRecord.live`, two-column live workspace, stale marker, tabs, read-only test |
| `663daf2` | Review fix: contract limits read through one `limitsOf()` helper |
| `8800406` | Merge to `main` |

## Acceptance evidence

Deterministic, no live model, no real GitHub issue, no deployed NFG:

- `pi-nf`: `npm test` → **84/84 pass**. New coverage: preview/no-side-effects, gap gate (`--yes` cannot bypass), confirmation required, one detached start, live reuse (`existing`), dead receipt `conflict` → `--restart` recover, orphan state DB hash-checked recovery, failed handshake kills the child and leaves no receipt, detached child outlives the launcher, transcript window/redaction/truncation/thinking-off, receipt `nfgPath` equals the projection a real pi-nf task publishes.
- NFG: `npm test` → **321/323 pass**; the two failures are pre-existing and environmental (both spawn `pwsh.exe`, which is absent here: `spawnSync` returns `ENOENT`, `status=null`). They do not import any module this SPEC changed. New coverage: v1 vs v2 discovery, malformed transcript items dropped, escaping, stale marker, chat/stage tabs, read-only (projection file byte-identical and directory unchanged after GETs and a rejected POST), limits rendering.
- Cross-repository identity: the pi-nf receipt's `nfgPath` is asserted equal to `auditDirectory(workspace, task_id)/audit.json`, which is the file NFG discovers; NFG's own v2 fixture renders both columns from the same task id.

## Review

Two axes were run as two separate passes over `git diff main...HEAD` in both repositories, with the repo's documented standards (AGENTS.md, tracker conventions) plus the Fowler smell baseline.

- **Standards** findings fixed: Divergent Change (`needs-forever.ts` mixed module, resolver, formatting, Pi adapter), Duplicated Code (receipt literal built twice; limits parsed five times inline; duplicated timestamp helper), Middle Man (`numberFromIssue`), Speculative Generality (redundant `ProjectConfig` field declarations), a dynamic `spawn` import, and a type declared in the wrong module.
- **Spec** findings fixed: `--restart` counted as confirmation for a brand-new task (spec requires `--yes` or `--contract`); "started" could read as "visible" (receipt now records `nfgVisible`); `status [454]` required an issue (now optional; a read-only inventory).
- Remaining judgement calls, not fixed: pre-existing dead helpers `roleName`/`eventHtml` in `ui.ts`; `asRecord`/`stringOf` helpers exist in several modules (pre-existing repo pattern); `messageAt` tolerates seconds-based fixtures.

**Process deviation:** the `code-review` skill calls for parallel reviewer sub-agents. Every subagent invocation fails in this environment (`error: option '-p, --port <port>' argument '--no-session' is invalid`), so both axes were executed by this agent as separate review passes. This is self-review, not independent review.

## Known limits

- Handoff semantics: `/needs-forever` starts a **new A session**; the launching Pi session is a launcher/observer. In-session takeover is out of scope.
- MVP polling: NFG refreshes every 1.5s from the committed projection; there is no token-level streaming/SSE.
- Issue resolution requires a GitHub `origin`; a prose-only issue is a draft and cannot start.
- The transcript window is the newest 200 items; older items are omitted (`has_more`).
- thinking is included by default (redacted, collapsed in the UI) and can be disabled (`audit --no-thinking`).
- NFG remains read-only for pi-nf tasks; pause/resume/delete stay in the pi-nf CLI.
- A's filesystem access is unchanged: a read-only projection does not sandbox A.
- Windows: `pi install D:/Pi/pi-nf/pi-nf` then `/reload`; the command runs in the current session's `cwd`.

## Tracker

- Tickets #23–#28 closed after this record; SPEC #22 closed with the evidence above.
