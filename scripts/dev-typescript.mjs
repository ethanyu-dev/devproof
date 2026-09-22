import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Starting a second compiler beside an already running API rewrites dist and
// immediately revokes live browser connections. Wait for the watcher's own build.
export function startTypeScriptDev({
  launch = spawn,
  compilerFile,
  output = process.stdout,
  finish = (code) => process.exit(code),
}) {
  const compiler = launch(
    process.execPath,
    [
      compilerFile,
      "-p",
      "tsconfig.build.json",
      "--watch",
      "--preserveWatchOutput",
      "--pretty",
      "false",
    ],
    {
      stdio: ["inherit", "pipe", "inherit"],
    },
  );
  let runtime;
  let pending = "";
  let stopping = false;
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    compiler.kill("SIGTERM");
    runtime?.kill("SIGTERM");
    finish(code);
  };
  compiler.stdout.on("data", (chunk) => {
    output.write(chunk);
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? "";
    if (
      !stopping &&
      !runtime &&
      lines.some((line) =>
        /Found 0 errors\. Watching for file changes\./u.test(line),
      )
    ) {
      runtime = launch(process.execPath, ["--watch", "dist/main.js"], {
        stdio: "inherit",
      });
      runtime.once("error", () => stop(1));
      runtime.once("exit", (code) => stop(code ?? 1));
    }
  });
  compiler.once("error", () => stop(1));
  compiler.once("exit", (code) => stop(code ?? 1));
  return stop;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const require = createRequire(resolve("package.json"));
  const stop = startTypeScriptDev({
    compilerFile: require.resolve("typescript/bin/tsc"),
  });
  process.once("SIGINT", () => stop());
  process.once("SIGTERM", () => stop());
}
