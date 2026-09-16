import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const sourceRun = process.argv[2];
if (!sourceRun)
  throw new Error(
    "Usage: node scripts/object-evidence-suite.mjs SOURCE_RUN [ROUNDS=5]",
  );
const rounds = Number(process.argv[3] ?? 5);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10)
  throw new Error("Rounds must be 1–10.");
const root = fileURLToPath(new URL("../", import.meta.url));
const results = [];
const started = Date.now();
const modes = ["base", "combined", "focus"];
for (let round = 0; round < rounds; round++) {
  const order = modes.map((_, i) => modes[(i + round) % modes.length]);
  // Three isolated browsers use the same configured model. Wall times are under
  // shared load; calls, tokens and correctness are the primary comparison.
  const runs = await Promise.all(
    order.map(
      (mode) =>
        new Promise((resolve) => {
          const child = spawn(
            process.execPath,
            [
              "scripts/object-evidence-comparison.mjs",
              "--source-run",
              sourceRun,
              "--mode",
              mode,
            ],
            { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
          );
          let stdout = "",
            stderr = "";
          child.stdout.on("data", (chunk) => {
            stdout += chunk;
          });
          child.stderr.on("data", (chunk) => {
            stderr = (stderr + chunk).slice(-2000);
          });
          child.on("error", (error) =>
            resolve({ round, mode, error: String(error) }),
          );
          child.on("close", async (code) => {
            const complete = stdout
              .split("\n")
              .flatMap((line) => {
                try {
                  const event = JSON.parse(line);
                  return event.event === "completed" ? [event] : [];
                } catch {
                  return [];
                }
              })
              .at(-1);
            const report = complete
              ? JSON.parse(await readFile(complete.file, "utf8"))
              : undefined;
            const result = {
              round: round + 1,
              mode,
              code,
              file: complete?.file,
              verdict: report?.outcome?.verdict,
              elapsedMs: report?.elapsedMs,
              modelCalls: report?.modelCalls,
              browserCalls: report?.operations.length,
              requestBytes: report?.requestBytes,
              inputTokens: report?.inputTokens,
              outputTokens: report?.outputTokens,
              closed: report?.closed,
              contractDigest: report?.contractDigest,
              error: report?.error ?? (code ? stderr : undefined),
            };
            console.log(JSON.stringify(result));
            resolve(result);
          });
        }),
    ),
  );
  results.push(...runs);
}
await mkdir(new URL("../release/object-evidence/", import.meta.url), {
  recursive: true,
});
const output = new URL(
  `../release/object-evidence/suite-${started}.json`,
  import.meta.url,
);
await writeFile(
  output,
  JSON.stringify({ rounds, concurrency: 3, sourceRun, results }, null, 2),
);
console.log(
  JSON.stringify({
    suite: output.pathname,
    passed: results.filter((r) => r.verdict === "PASSED" && r.closed).length,
    total: results.length,
  }),
);
if (results.some((r) => r.code || r.verdict !== "PASSED" || !r.closed))
  process.exitCode = 1;
