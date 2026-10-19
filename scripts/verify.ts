import { execFile } from "node:child_process";
import { randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const steps = ["typecheck", "build", "test:reliability", "test:compose"] as const;
let phase = "configuration";

function redact(output: string): string {
  return output.replace(/umq_[A-Za-z0-9_-]+/g, "[REDACTED_API_KEY]")
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/g, "[REDACTED_DATABASE_URL]");
}

try {
  const npmCli = process.env.npm_execpath;
  if (npmCli === undefined) throw new Error("Run this entry point with npm run verify.");
  const rawSeed = process.env.VERIFY_TEST_SEED ?? String(randomInt(1, 2_147_483_647));
  if (!/^[0-9]+$/.test(rawSeed) || Number(rawSeed) > 2_147_483_647) {
    throw new Error("VERIFY_TEST_SEED must be an integer from 0 to 2147483647.");
  }
  const environment = { ...process.env, VERIFY_TEST_SEED: rawSeed };
  const revision = (await runFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const dirty = (await runFile("git", ["status", "--porcelain"], { cwd: root })).stdout.trim() !== "";
  console.log(`Regression gate started ${new Date().toISOString()}`);
  console.log(`Command: npm run verify; Node ${process.version}`);
  console.log(`Commit: ${revision}; working tree ${dirty ? "has uncommitted changes" : "clean"}`);
  console.log(`Vitest shuffle seed: ${rawSeed} (files and tests)`);

  for (const step of steps) {
    phase = step;
    console.log(`RUN npm run ${step}`);
    try {
      const result = await runFile(process.execPath, [npmCli, "run", step], {
        cwd: root, env: environment, timeout: 600_000, maxBuffer: 12 * 1024 * 1024
      });
      if (result.stdout !== "") process.stdout.write(redact(result.stdout));
      if (result.stderr !== "") process.stderr.write(redact(result.stderr));
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      if (failure.stdout) process.stdout.write(redact(failure.stdout));
      if (failure.stderr) process.stderr.write(redact(failure.stderr));
      throw new Error(`npm run ${step} failed; later stages were not run.`);
    }
    console.log(`PASS npm run ${step}`);
  }
  console.log(`PASS regression gate completed ${new Date().toISOString()}`);
} catch (error) {
  console.error(`FAIL regression gate at ${phase}: ${error instanceof Error ? redact(error.message) : "Unknown failure."}`);
  process.exitCode = 1;
}
