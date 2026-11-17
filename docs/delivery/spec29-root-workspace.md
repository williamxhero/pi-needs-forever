# SPEC #29 — root workspace acceptance

Requirement: [#29](https://github.com/williamxhero/pi-needs-forever/issues/29). Tickets: [#30](https://github.com/williamxhero/pi-needs-forever/issues/30), [#31](https://github.com/williamxhero/pi-needs-forever/issues/31), [#32](https://github.com/williamxhero/pi-needs-forever/issues/32).

Reviewed implementation: `43060dd13126cf058c5da143034ad5aa9b364850`; fixed review base: `321776f07bda4c2ad1c12747e3690792f6f72d62`. Evidence collected on 2026-11-17. This document records implementation acceptance, not a claim that tracker state alone proves delivery. Main merge, safe cleanup, push/remote equality and Issue closure are recorded with their actual SHAs in the final GitHub completion comments.

## Result and scope

A user can keep Pi at a project root and launch one background A for project-owned nested repositories. A and the fixed-argv CompletionGate retain the same root workspace; a command can use a child directory without changing the user's session. Git histories/remotes and GitHub repository identity remain independent. The current Pi chat remains a launcher/observer, not the new A.

No contract field/version, `scope`, `projects`, `verify.cwd`, `digest.include`, RepoOps layer, monorepo conversion, scheduler, endpoint, audit schema or NFG-source change was added. Package manifests were not part of this implementation. See [the root-workspace usage guide](../../pi-nf/README.md#one-root-workspace-with-nested-repositories) and [runnable example](../../pi-nf/examples/root-workspace).

### Delivery lineage

| Work | Implementer commit | Independent integration merge |
| --- | --- | --- |
| #30 rule access, root development and Git/GitHub ownership | `9e9cd37`, follow-up `3138c10` | `3b1ebbb` |
| #31 streaming, typed framing, coverage and audit self-change | `5d31d65` | `6c9b3a6` |
| #32 detached handoff fixture and runnable documentation | `2aa6b80` | `01ea213` |
| #31 measured bounded-throughput continuation | `e867f24` | `c8458cb` |
| Review: contextual rather than name-only exclusions | `cdbe09e` | `8ec8f0a` |
| Review: repositories deeper inside generated directories | `d7b92af` | `2f4160b` |
| Review: ordinary `.git` directory during discovery; shared metadata classifier | `8576881` | `43060dd` |

Implementers used isolated worktrees/fresh Pi processes, with separate merger processes. The registered subagent launcher failed before running a model (`--no-session` interpreted as a port); the documented standalone Pi JSON CLI was used as a working independent-process route. No global harness modification or self-review substitution was used. Transient provider errors interrupted some agents; existing work and evidence were preserved and fresh contexts resumed it.

## Acceptance map

| SPEC criterion | Observable evidence |
| --- | --- |
| Root preview/start, contract, A cwd, gate cwd, receipt and projection agree | `test/root-handoff.test.ts` and `test/fixtures/root-handoff.ts`: same task/hash/SQLite, root argv and audit path; detached child survives launcher exit |
| Same A edits two independent nested Git repositories | Real Host/CodingTools in `root-development.test.ts` and coherent detached handoff fixture |
| Required root checks: alpha fails, beta fails, both pass | Handoff tests assert never DONE for either failure and DONE only for success; runnable example checks each command-local cwd |
| Nested protected-file tampering cannot pass | `digest.test.ts` and existing verification tests: exit-0 verifier still fails independent protected baseline |
| Source/config, untracked/Git-ignored, addition/deletion are covered | Real nested Git fixtures and verifier mutations in `digest.test.ts`; before/after mismatch prevents pass |
| Supervisor state/cache writes do not produce false change; source isn't blanket skipped | Real audit republishing, explicit SQLite/WAL/SHM, marked-cache fixtures; same-name files/directories and ordinary `.git` source covered |
| Root and more-specific rules reach new A before mutation | Real provider-delivered prompt assertions and read-tool results before source edits; no launcher-history assumption |
| Git ownership and existing dirty work preserved | Real exact-path staging/commits in two child histories; root/other history unaffected; dirty/untracked notes preserved; optional authorized push only to temporary local bare remote |
| Same-number GitHub Issues keep explicit repository; UTF-8 body upload/readback and authorization | Existing IssueReader Adapter + controlled gh-shaped subprocess fixture; distinct `fixture/alpha#7` / `fixture/beta#7`; authorized vs withheld push/closure cases |
| Correctness/performance and fail-closed scans | Large/many-file child measurements, actual Windows exclusive unreadable source and missing-root errors; contextual cache-collision/deep-repository regressions |
| Existing contract/hash, preview/gaps, recovery, single-workspace and read-only projection regressions | Complete `pi-nf/` package suite: **125 passed, 0 failed, 0 skipped**, exit 0 at reviewed implementation |
| Actionable root usage documentation | Root config, root verifier, per-project checks and applicable rules in `examples/root-workspace`; real execution tested |
| Independent Standards and Spec reviews; findings fixed | Both independent whole-diff final reports below have CODE PASS; regression and final-SHA measurements completed separately by coordinator |

The package under test is **`pi-nf/`**, not the legacy Codex package at repository root. Some intermediate agents initially invoked the wrong root package and got missing `tsc`; those failures are not counted as pi-nf regressions or successful tests. Correct package-directory runs are the acceptance evidence.

## Independent review

- [Standards report](spec29-evidence/review-standards.md): no documented-standard breaches or actionable correctness/security findings. Minor repeated comparator and self-contained toy-check duplication were explicitly non-blocking judgment calls; no speculative abstraction was added merely to remove them.
- [Spec report](spec29-evidence/review-spec.md): CODE PASS, no concrete implementation defect or unrequested scope.

Earlier review findings were not suppressed: name-only cache/source collisions, repositories deeper under generated parents and non-metadata `.git` discovery pruning each received real failing public gate/digest tests, corrections by fresh implementers, independent merges and whole-diff rechecks. Discovery and normal walking now share the private Git metadata classifier.

Reviewers performed static inspection, not test or benchmark execution. Their reports correctly list evidence pending **at review time**; the following measurements and the 125/125 integration regression were subsequently confirmed by the coordinator/independent merger. Review CODE PASS is not a substitute for remaining main/cleanup/push/tracker gates.

## Digest policy and performance

File content is streamed, at most eight active regular-file streams globally. A batch retains paths and fixed-size hashes, drains siblings on failure, and commits sorted results in deterministic order. Typed JSON framing prevents filename/content concatenation collisions and preserves file/directory/link identity. Link/junction targets are not traversed. Filesystem errors propagate rather than yielding a partial success token.

Generated exclusions require context: actual Git metadata, explicit state database/WAL/SHM, root reserved `.pi-nf`, npm hidden lockfile, virtual-environment `pyvenv.cfg`, or a valid cache-tag signature for supported tool caches. Unknown coverage/bytecode and unmarked lookalikes remain covered; protected files are independently checked even inside generated storage. Recognized generated containers receive sequential **metadata-only discovery** for independent Git roots at any depth, including through ordinary non-metadata `.git` directories. Such roots are then normally digested using original workspace-relative names. Ordinary generated payload is not content-hashed. This preserves nested repositories without a new public configuration model.

The policy is cooperative, not protection against deliberately forged markers or adversarial filesystem replacement. Metadata discovery adds cost. Sorted directory metadata scales with width/depth; bounded content streams do not promise a universal total-memory limit. Unknown generated writes can conservatively cause a retry. Protected baseline content storage is a separate existing representation and is not made streaming by this change.

### Reproducible synthetic observations

Environment: Node **v24.19.0**, npm **11.19.1**, Windows 11 Pro Insider Preview **10.0.26320 x64**, Intel Core **i5-12400F**. Real local files, no page-cache flush/cold-disk claim. Dataset creation excluded from elapsed; fresh Node scan children run with `--max-old-space-size=64`. RSS is measured separately because this heap limit does not bound Buffers/process memory. CPU sums runtime threads and can exceed elapsed.

Retained datasets: one file of N MiB of `0x61`, plus M distinct 1024-byte source files of `x`, under `projects/large`. Baseline and final use the same retained files, three runs each. [Sequential/batch raw comparison](spec29-evidence/sequential-batch-comparison.jsonl); [final reviewed-SHA runs](spec29-evidence/final-synthetic.jsonl).

| Dataset | Sequential-stream baseline elapsed median | Final reviewed SHA elapsed range (median) | Final user CPU range | Final system CPU range | Final peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| 256 MiB + 5,000 source files | 4,555.87 ms | 1,219.60–1,497.34 ms (**1,257.04 ms**) | 703–812 ms | 1,016–1,422 ms | 98.56–99.29 MiB |
| 512 MiB + 20,000 source files | 14,702.15 ms | 4,296.37–5,245.15 ms (**4,407.98 ms**) | 1,547–1,890 ms | 4,047–5,906 ms | 101.85–104.29 MiB |

All baseline/batch/final runs have equal dataset hashes:

- 256 MiB + 5k: `51109d279b57a76eff32646551f6c99cec8aa976ff1d994330d22cbb67ed1967`
- 512 MiB + 20k: `030b8c27b4a10722fd8b3afb4ab451a5b5474a99e825d40fec9d8f3d3b5cb565`

Before streaming, a separate 512 MiB + 128-file dataset used about **577 MiB** peak RSS; sequential streaming used about **98 MiB** ([old readFile samples](spec29-evidence/readfile-512-baseline.jsonl), [streaming samples](spec29-evidence/stream-512-measurement.jsonl)). The initial memory/framing fix did not demonstrate elapsed speedup; later bounded batching improved the many-small-file samples above. These are dataset-specific observations, not a guaranteed speedup for arbitrary projects.

Reproduce the checked-in benchmark from `pi-nf/`:

```powershell
npm run build
node dist/test/fixtures/digest-benchmark.js 256 5000 3
node dist/test/fixtures/digest-benchmark.js 512 20000 3
node dist/test/fixtures/digest-benchmark.js 32 257 2 8
```

The benchmark creates/removes only its own synthetic temporary files. The retained same-file baseline harness and full TDD/intermediate logs remain in local `.scratch/spec-29/`; the compact raw result files above are preserved in Git so cleanup of worktrees does not remove the acceptance record.

### Real QuantResearch root — read-only observation, not business acceptance

At the final reviewed implementation, a single content digest of `D:/WILL/STOCK/QuantResearch` completed with exit 0 in **146,250.68 ms**, user CPU **72,625 ms**, system CPU **114,203 ms**, peak RSS **199,216 KiB = 194.55 MiB**. [Raw result](spec29-evidence/final-root.jsonl). Inventory before these scans showed over 35 GiB and 240k files (not an exact same-time dataset count). The preceding conservative-policy scan also completed in 153.21 seconds with the same digest; no two-snapshot business gate was run.

Earlier 90/180-second timeouts remain timeouts, not completed baselines. An intermediate less-conservative policy's 116.44-second scan is not the final policy's measurement; no numerical real-root speedup is claimed. No target writes, business verifier, live model, production service operation, business tracker mutation or QuantResearch development was performed. A root this large still incurs substantial cost for each of the gate's **two** scans; this is explicitly recorded, not hidden by changing the workspace to a child repository.

## Real versus fixture evidence and remaining limitations

- **Real locally:** directories, independent Git repositories/history, local bare remotes, filesystem locks, executable processes, detached launcher/child lifetime, SQLite, Host, CodingTools, fixed argv root gate, receipt, audit republishing and read-only HTTP observation.
- **Explicit fixture Adapters:** worker/provider and judge, IssueReader/controlled external gh-shaped executable, and handoff executable test entry opening the production Host. There is at least one coherent entry-to-audit fixture; independent segmented fixtures are not claimed as that end-to-end proof.
- **Not established:** live provider behavior, autonomous model reasoning/compliance, live GitHub updates, deployed NFG UI acceptance, real business correctness, OS sandboxing or atomic/race-hardened filesystem snapshots. Arbitrary shell commands are not physically confined; prompt/rule authorization is cooperative. Existing STOP/dependency/time/production restrictions stay in force.
- This work does not retroactively mark historical SPEC #22's NFG full-suite failures or independent-review gaps as passed. No NFG source was changed or NFG suite rerun for #29.
- Pre-existing main-worktree edits to `pi-nf/package.json`, `pi-nf/package-lock.json` and untracked `pi-nf/test/package.test.ts` were byte-hashed and preserved, excluded from this delivery's commits. They are not a reason to reset/stash the project or claim its working tree is clean.
