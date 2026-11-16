# Migration from needs-forever

This repository is the new working repository for **pi-nf**, the Pi Durable implementation of Needs Forever.

- Source baseline: `williamxhero/needs-forever` at commit `32c9a9c` (imported 2026-11-16).
- The source repository remains the reference for the Codex Desktop supervisor and its historical evidence. Historical docs and evidence in this tree may still reference the source repository or old paths; that is intentional provenance, not the current issue tracker.
- Current issue tracker: `williamxhero/pi-needs-forever` (see `docs/agents/issue-tracker.md`).
- Work in progress: port the supervision policy (contract, evidence-gated judge, route planning, verification, recovery) onto `@earendil-works/pi-durable`. The Codex-specific transport and daemon layers are migration reference only and will be replaced.
- Design: [`docs/design/pi-nf-modules.md`](docs/design/pi-nf-modules.md) records the deep-module map, the single external seam, adapters, and testing strategy for the port.
- First implementation: [`pi-nf/README.md`](pi-nf/README.md) documents the SPEC 1 host, contract, supervision loop, CLI, and its explicit limits. Visual overview: [`docs/design/pi-nf-architecture.html`](docs/design/pi-nf-architecture.html).
- The local clone keeps the source as the `upstream` remote for reference. Do not push new work to `upstream`.
- Do not assume the source's `main` is still the release branch for this project.
