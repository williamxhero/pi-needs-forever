// One root gate; command-local cwd is an implementation detail, not a new workspace.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

console.log(JSON.stringify({ root: process.cwd() }));
let failed = false;
for (const project of ["alpha", "beta"]) {
  const result = spawnSync(process.execPath, ["check.mjs"], {
    cwd: join(process.cwd(), "projects", project),
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const passed = !result.error && result.status === 0;
  console.log(`${project}: ${passed ? "PASS" : "FAIL"}`);
  if (result.error) console.error(`${project}: ${result.error.message}`);
  failed ||= !passed;
}
process.exitCode = failed ? 1 : 0;
