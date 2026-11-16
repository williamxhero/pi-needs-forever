# SPEC 3 delivery record

- SPEC: https://github.com/williamxhero/pi-needs-forever/issues/3
- Parent: https://github.com/williamxhero/pi-needs-forever/issues/5
- Tickets: #16, #17, #18
- Integration branch: `spec/3-c2`
- Implements on top of SPEC 2 (`6200df5`).

## Scope delivered

- `c2.mode` defaults to `enforce`; `shadow` and explicit `legacy` are accepted. Legacy remains available for compatibility fixtures but is no longer the default.
- C2 diagnosis/route-plan/candidate/catalog/ledger types and stable route family/fingerprint helpers.
- B discovers up to four bounded, non-secret local workspace artifacts at start, records source/digest evidence and authorization in a durable catalog.
- Every CONTINUE in enforce mode requires a diagnosis and route plan; selected route actions become the canonical `next_message`.
- Observed candidates require matching catalog evidence; blocked/excluded candidates require matching evidence; provider prose cannot assert availability.
- Material distinctness and single-route justification are enforced; missing diagnosis/plan is rejected in enforce mode.
- Route ledger persists attempts and outcomes. A third equivalent family attempt is rejected; a second same-family failure needs a new hypothesis or discriminating check.
- Every delivered C2 CONTINUE records a route execution in the durable route document and carries `plan_id`/`route_id` in `nf.direction`.
- The next round captures the previous route outcome as an attempt (`diagnostic`/`failure`); `nf.judge` writes the updated catalog/ledger in the snapshot commit.
- Bounded inventory JSON from a tool result is parsed and independently verified against the workspace; provider/API hints are ignored, missing artifacts remain unobserved.
- WAIT_EXTERNAL requires complete route context, every catalog route attempted/excluded with evidence, and matching external fields.
- Status exposes C2 mode, selected route, candidate count, ledger attempts, and last outcome.
- `nf.judge` task remains version 2; the SPEC 2 checkpoint migration is retained.

Not in this build: arbitrary provider/API probing, network authorization/quota proof, full C2 context omission budgeting (context is currently complete), pause/resume/limits/UI (SPEC 4). Limits remain stored but unenforced.

## Standards review

Fixed point: `main...spec/3-c2`. Standards sources: `AGENTS.md`; no `CODING_STANDARDS.md`/`CONTRIBUTING.md`. Fowler baseline applied.

Findings fixed during review:

- Diagnosis class was not validated; it now uses the fixed Needs Forever enum.
- C2 mode default changed to enforce; existing SPEC 1/2 fixtures explicitly declare `legacy`, and the contract test now covers enforce/shadow/legacy.
- Route plans are preserved by `validateDecision` instead of being dropped/rejected before C2 admission.
- `nf.judge` stores route execution only after the stale input/task fence, so a superseded round cannot leave an execution.
- Route selection is retained in control state for status after a later DONE.
- Inventory parsing ignores provider/API/command hints and only observes artifacts B can actually read.
- Exported the route policy/types through the package index.

Judgement calls: `routes.ts` is large but pure policy; splitting validator/catalog/ledger would spread one decision across modules. `context_complete` is always true for the first version; omission budgets are a later refinement. Provider/API probes are intentionally out of scope.

## Spec review

| SPEC 3 area | Evidence |
|---|---|
| C2 diagnosis/route plan | `routes.test.ts`, `c2.test.ts` |
| Material distinctness/single route | `routes.test.ts` |
| Observed grounding | `routes.test.ts` |
| Third equivalent rejection | `routes.test.ts` |
| Second same-class hypothesis/discriminating check | `routes.test.ts` |
| WAIT_EXTERNAL gate | `routes.test.ts` |
| Local artifact catalog | `discoverLocalRoutes`, `c2.test.ts` |
| Inventory hints | `routes.test.ts`, `ingestInventory` |
| Direction audit plan/route | `c2.test.ts` |
| Outcome capture/status | `c2.test.ts`, `RoutePolicy.capture` |
| Restart persistence | route document is durable; SPEC 2 crash suite still passes |
| Stale plan fence | `nf.judge` task-version/epoch checks |

Test command/result:

```text
cd pi-nf
npm test
# 63 tests, 63 pass, 0 fail
```

The suite uses faux worker/judge models, local artifacts and local verifier subprocesses. It does not claim live model or provider acceptance.

## Delivery gates

- [x] Implementation and tests on the SPEC integration branch.
- [x] Standards and Spec review with fixes.
- [ ] Integration branch merged into `main`.
- [ ] Temporary worktree and merged branches removed.
- [ ] `main` pushed and local/remote equality verified.
- [ ] Tickets and SPEC #3 closed with this record.

## Process note

The installed `subagent` mechanism still fails before starting any agent with:

```text
option '-p, --port <port>' argument '--no-session' is invalid
```

Implementation used the main agent in an isolated worktree and a manual two-pass review. This is a recorded deviation, not a claim of successful subagent execution.
