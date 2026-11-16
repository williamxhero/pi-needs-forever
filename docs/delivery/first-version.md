# pi-nf first version — overall delivery

- Total SPEC: https://github.com/williamxhero/pi-needs-forever/issues/5
- Child SPECs: #1, #2, #3, #4 (all closed)
- Tickets: #6–#21 (all closed)
- Implementation: `pi-nf/` on `@earendil-works/pi-durable@1.5.2`
- Main at delivery record: `c607b93`

## Delivered capabilities

- Durable SQLite host, contract validation/hash, single-writer lease with safe stale-owner recovery.
- Worker A root conversation with coding tools and contract prompt.
- `afterRun` → `nf.judge` → tool-free `ModelJudge`/`FixtureJudge` → strict CONTINUE/DONE/WAIT_EXTERNAL.
- Evidence snapshot from real transcript/tool entries, 24k budget, redaction, explicit omissions.
- CONTINUE direction with durable `nf.direction` entry, deterministic request ID, atomic decision/submission.
- Crash/reopen at snapshot/judge/delivery without duplicate directions.
- Fixed-argv `nf.verify` gate with protected baseline, before/after hashes, workspace digest, repair CONTINUE.
- C2 route plan/catalog/ledger, local artifact grounding, bounded inventory, third-equivalent rejection, WAIT_EXTERNAL gate.
- pause/resume, input epochs, cumulative limits (`max_worker_turns`/`max_minutes`/judge `max_tokens`/`max_cost`), PAUSED/user_limit, INTERRUPTED + explicit resume.
- Read-only local web status, JSON status, CLI start/status/send/pause/resume/web.
- Package README/example, delivery records for every child SPEC.

## Verification

```text
cd pi-nf
npm test
# 67 tests, 67 pass, 0 fail
node dist/src/cli.js --help
npm pack --dry-run   # 140 files, 134.5 kB package
```

Evidence classes:

- simulated worker/judge via faux provider;
- real local tool/verifier subprocesses;
- real child-host kill/reopen against SQLite;
- local read-only HTTP server;
- no live model or live provider acceptance is claimed.

Per-SPEC evidence: `docs/delivery/spec1-delivery.md`, `spec2-delivery.md`, `spec3-delivery.md`, `spec4-delivery.md`.

## Known limitations

- C2 makes no arbitrary provider/API network calls and cannot prove authorization/quota; only observed local artifacts and failures are grounded. Context omission budgeting is not implemented (`context_complete` is currently always true).
- Authentication/quota-specific RECOVERING classification is not implemented; judge transport failures become INTERRUPTED. Restart-limit interruption is wired through `onReport`/`markInterrupted`.
- Limit token/cost accounting covers judge usage, not worker A's conversation usage. Limits remain stored but are enforced only for the paths above.
- `start`/`send`/`pause`/`resume` CLI commands are one-shot writers; a concurrently running host owns the lease. `status`/`web` are read-only.
- The web page is a status projection, not the full NFG interaction surface.
- `NodeExecutionEnv` is a cooperative process boundary, not an OS sandbox. Stronger isolation needs a container/VM/dedicated user.
- Old Codex `state.json`/threads are not migrated; only contracts are reusable.

## Process note

The installed `subagent` mechanism failed before starting any agent with:

```text
option '-p, --port <port>' argument '--no-session' is invalid
```

All implementation was done by the main agent in isolated git worktrees, merged ticket-by-ticket, with a manual Standards/Spec review per SPEC. This is a recorded deviation from the subagent-based `/implement-spec` mechanics, not a claim of successful subagent execution.
