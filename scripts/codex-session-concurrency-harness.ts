import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CONTROLLER_REFRESH_SENTINEL,
  parseChatgptSubscriptionAuthText,
  type ChatgptSubscriptionAuth,
} from "../src/trigger/subscription-auth";
import {
  AesGcmSessionSnapshotCipher,
  ManagedSubscriptionSessionController,
  MemorySessionStateStore,
} from "../src/trigger/subscription-session";
import { prepareSubscriptionEnv } from "../src/trigger/subscription-runtime";
import { CODEX_SESSION_SOURCE, CODEX_SESSION_SOURCE_ENV } from "../src/trigger/subscription-source";

const WORKERS = 24;
const now = Date.now();

// The synthetic harness exercises the same explicit production source gate;
// it does not install any credential material in the environment.
process.env[CODEX_SESSION_SOURCE_ENV] = CODEX_SESSION_SOURCE;

function token(expiresAt: number, marker: string) {
  const header = Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt / 1_000), marker })).toString("base64url");
  return `${header}.${payload}.harness`;
}

function auth(expiresAt: number, version: number): ChatgptSubscriptionAuth {
  return {
    OPENAI_API_KEY: null,
    auth_mode: "chatgpt",
    last_refresh: new Date(now - version * 1_000).toISOString(),
    tokens: {
      access_token: token(expiresAt, `access-${version}`),
      refresh_token: `synthetic-refresh-${version}`,
      id_token: token(expiresAt + 60_000, `identity-${version}`),
      account_id: "synthetic-account",
    },
  };
}

const store = new MemorySessionStateStore();
let rotations = 0;
const controller = new ManagedSubscriptionSessionController({
  store,
  cipher: new AesGcmSessionSnapshotCipher(Buffer.alloc(32, 19)),
  bootstrap: async () => auth(now - 1_000, 1),
  rotate: async (_current, context) => {
    rotations += 1;
    await new Promise((resolve) => setTimeout(resolve, 15));
    // This is the synthetic provider crossing point. Production marks the
    // durable effect immediately before writing account/read to Codex stdin.
    await context.markEffect();
    return auth(now + 60 * 60_000, 2);
  },
});

async function main() {
  const root = mkdtempSync(join(tmpdir(), "jarvis-codex-session-e2e-"));
  try {
    const prepared = await Promise.all(Array.from({ length: WORKERS }, (_, index) =>
      prepareSubscriptionEnv("codex", {
        controller,
        root,
        scope: `trigger-worker-${index}`,
      })));
    const errors = prepared.flatMap((item) => item.error ? [item.error] : []);
    if (errors.length) throw new Error(`consumer preparation failed (${errors.length})`);
    const homes = prepared.map((item) => String(item.env.CODEX_HOME));
    const refreshValues = homes.map((home) =>
      parseChatgptSubscriptionAuthText(readFileSync(join(home, "auth.json"), "utf8")).tokens.refresh_token);
    const stateText = JSON.stringify(await store.readState());
    const receipt = {
      workers: WORKERS,
      rotations,
      snapshotVersions: [...new Set(prepared.map((item) => item.snapshotVersion))],
      uniqueWritableHomes: new Set(homes).size,
      workerRefreshValues: [...new Set(refreshValues)],
      durableStateContainsSubscriptionMaterial: /synthetic-(?:refresh|account)|access-2/.test(stateText),
    };
    if (rotations !== 1
      || receipt.uniqueWritableHomes !== WORKERS
      || receipt.workerRefreshValues.length !== 1
      || receipt.workerRefreshValues[0] !== CONTROLLER_REFRESH_SENTINEL
      || receipt.durableStateContainsSubscriptionMaterial) {
      throw new Error("concurrency invariant failed");
    }
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch(() => {
  process.stderr.write("Codex session concurrency harness failed without exposing session material.\n");
  process.exitCode = 1;
});
