import { runAgentHarness } from "../src/trigger/agent-runner";

const result = await runAgentHarness();
process.stdout.write(`${JSON.stringify(result)}\n`);

