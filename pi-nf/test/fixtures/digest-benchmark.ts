// Reproducible synthetic benchmark; only the child scan is timed/measured.
// node dist/test/fixtures/digest-benchmark.js [MiB=256] [small-files=128] [runs=1]
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { workspaceDigest } from "../../src/verify.js";

if (process.argv[2] === "--scan") {
  const cpu = process.cpuUsage();
  const started = performance.now();
  const digest = await workspaceDigest(process.argv[3]!, null);
  const usage = process.cpuUsage(cpu);
  console.log(JSON.stringify({
    digest,
    elapsed_ms: performance.now() - started,
    cpu_user_ms: usage.user / 1000,
    cpu_system_ms: usage.system / 1000,
    peak_rss_kib: process.resourceUsage().maxRSS,
    final_rss_bytes: process.memoryUsage().rss,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  }));
} else {
  const mib = Number(process.argv[2] ?? 256);
  const smallFiles = Number(process.argv[3] ?? 128);
  const runs = Number(process.argv[4] ?? 1);
  const workspace = mkdtempSync(join(tmpdir(), "pi-nf-digest-bench-"));
  try {
    const nested = join(workspace, "projects", "large");
    mkdirSync(nested, { recursive: true });
    const fd = openSync(join(nested, "dataset.bin"), "w");
    try {
      const chunk = Buffer.alloc(1024 * 1024, 0x61);
      for (let i = 0; i < mib; i++) writeSync(fd, chunk);
    } finally {
      closeSync(fd);
    }
    for (let i = 0; i < smallFiles; i++) writeFileSync(join(nested, `source-${i}.ts`), "x".repeat(1024));
    for (let run = 0; run < runs; run++) {
      const result = spawnSync(process.execPath, ["--max-old-space-size=64", fileURLToPath(import.meta.url), "--scan", workspace], {
        encoding: "utf8", timeout: 60_000,
      });
      if (result.status !== 0) throw new Error(`scan failed: ${result.error ?? result.stderr}`);
      console.log(JSON.stringify({ mib, small_files: smallFiles, small_file_bytes: 1024, run: run + 1, ...JSON.parse(result.stdout) }));
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
