import { runAgentHarness } from "../src/trigger/agent-runner";

void (async () => {
  const result = await runAgentHarness();
  process.stdout.write(`${JSON.stringify(result)}\n`);
})().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
