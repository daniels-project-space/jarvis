import { spawn } from "node:child_process";
import { runAgentHarness } from "../src/trigger/agent-runner";
import { codexExecPrefix } from "../src/trigger/model-policy";
import {
  missingSubscriptionTools,
  prepareSubscriptionEnv,
  resolveSubscriptionAgentBin,
} from "../src/trigger/subscription-runtime";

function verifyCliTools(): Promise<{ cli: true; shellTool: true }> {
  const bin = resolveSubscriptionAgentBin("codex");
  const prepared = prepareSubscriptionEnv("codex");
  if (!bin || prepared.error) throw new Error(prepared.error ?? "Codex CLI binary unavailable");
  const missing = missingSubscriptionTools(prepared.env);
  if (missing.length) throw new Error(`Codex worker toolchain unavailable: missing ${missing.join(", ")} on PATH`);
  return new Promise((resolve, reject) => {
    const child = spawn(
      bin,
      [
        ...codexExecPrefix("luna"),
        "--json",
        "Use the shell tool to run: pwd; curl --version; git --version; node --version; npm --version; npx --version; gh --version. If every command succeeds, reply with exactly HARNESS_READY and nothing else.",
      ],
      { cwd: process.cwd(), env: prepared.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let error = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    child.stdout.on("data", (data) => (output += String(data)));
    child.stderr.on("data", (data) => (error = (error + String(data)).slice(-2000)));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      const events = output
        .split("\n")
        .map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter(Boolean);
      const usedShell = events.some((event) => event?.item?.type === "command_execution");
      const answered = events.some((event) => event?.item?.type === "agent_message" && event.item.text?.trim() === "HARNESS_READY");
      if (code === 0 && usedShell && answered) resolve({ cli: true, shellTool: true });
      else reject(new Error(`CLI harness self-test failed (${code ?? "no code"}): ${error.slice(-500)}`));
    });
  });
}

void (async () => {
  const result = process.env.JARVIS_HARNESS_SELF_TEST === "1"
    ? await verifyCliTools()
    : await runAgentHarness();
  process.stdout.write(`${JSON.stringify(result)}\n`);
})().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
