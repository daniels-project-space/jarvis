import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isolateSubscriptionEnv,
  isolateCloudSubscriptionEnv,
  missingSubscriptionTools,
  parseChatgptSubscriptionAuth,
  prepareSubscriptionEnv,
  REQUIRED_AGENT_TOOLS,
  resolveSubscriptionAgentBin,
  verifyCodexSubscriptionPreflight,
} from "./subscription-runtime";

const validAuth = {
  auth_mode: "chatgpt",
  tokens: {
    access_token: "eyJ.access.subscription",
    refresh_token: "refresh_subscription",
    id_token: "eyJ.id.subscription",
    account_id: "acct_subscription",
  },
};
const validAuthJson = JSON.stringify(validAuth);
const validAuthB64 = Buffer.from(validAuthJson, "utf8").toString("base64");

describe("subscription subprocess capability scope", () => {
  beforeEach(() => {
    vi.stubEnv("CODEX_AUTH_JSON_B64", validAuthB64);
    vi.stubEnv("CODEX_AUTH_JSON", undefined);
    vi.stubEnv("CODEX_ACCESS_TOKEN", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("withholds dispatcher, worker and GitHub authority from specialists", () => {
    vi.stubEnv("JARVIS_DISPATCH_TOKEN", "dispatch-capability");
    vi.stubEnv("JARVIS_WORKER_TOKEN", "worker-capability");
    vi.stubEnv("GITHUB_TOKEN", "github-capability");
    const specialist = prepareSubscriptionEnv("codex").env;
    expect(specialist.JARVIS_DISPATCH_TOKEN).toBeUndefined();
    expect(specialist.JARVIS_WORKER_TOKEN).toBeUndefined();
    expect(specialist.GITHUB_TOKEN).toBeUndefined();
    expect(specialist.GH_TOKEN).toBeUndefined();
  });

  it("preserves the executable and network runtime without passing application authority", () => {
    vi.stubEnv("PATH", process.env.PATH ?? "/usr/bin:/bin");
    vi.stubEnv("HTTPS_PROXY", "http://proxy.internal:8080");
    const specialist = prepareSubscriptionEnv("codex").env;
    expect(specialist.PATH).toBe(process.env.PATH);
    expect(specialist.HTTPS_PROXY).toBe("http://proxy.internal:8080");
    expect(specialist.GIT_TERMINAL_PROMPT).toBe("0");
    expect(specialist.OPENAI_API_KEY).toBe("");
    expect(specialist.CODEX_API_KEY).toBe("");
    expect(specialist.CODEX_ACCESS_TOKEN).toBeUndefined();
  });

  it("finds every required specialist binary on the worker PATH", () => {
    expect(missingSubscriptionTools(process.env, REQUIRED_AGENT_TOOLS)).toEqual([]);
  });

  it("reports an honest missing-tool list for an over-sanitized PATH", () => {
    expect(missingSubscriptionTools({ PATH: "/definitely/missing" }, ["curl", "git"])).toEqual(["curl", "git"]);
  });

  it("keeps bridge authentication in the Trigger host instead of every Codex child", () => {
    vi.stubEnv("JARVIS_DISPATCH_TOKEN", "dispatch-capability");
    vi.stubEnv("JARVIS_WORKER_TOKEN", "worker-capability");
    const supervisor = prepareSubscriptionEnv("codex").env;
    expect(supervisor.JARVIS_DISPATCH_TOKEN).toBeUndefined();
    expect(supervisor.JARVIS_WORKER_TOKEN).toBeUndefined();
  });

  it("ships the pinned Codex CLI that Trigger conversation workers resolve", () => {
    expect(resolveSubscriptionAgentBin("codex")).toMatch(/codex/);
  });

  it("gives concurrent agents separate Codex homes with shared auth only", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-codex-test-"));
    const source = join(root, "source");
    const homes = join(root, "homes");
    try {
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "auth.json"), validAuthJson);
      writeFileSync(join(source, "AGENTS.md"), "scoped briefing");
      const one = isolateSubscriptionEnv({ ...process.env, CODEX_HOME: source }, "job-one", homes);
      const two = isolateSubscriptionEnv({ ...process.env, CODEX_HOME: source }, "job-two", homes);
      expect(one.CODEX_HOME).not.toBe(two.CODEX_HOME);
      expect(readFileSync(join(String(one.CODEX_HOME), "AGENTS.md"), "utf8")).toBe("scoped briefing");
      expect(readFileSync(join(String(two.CODEX_HOME), "auth.json"), "utf8")).toBe(validAuthJson);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gives cloud specialists auth without inheriting user config or instructions", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-cloud-codex-test-"));
    const source = join(root, "source");
    const homes = join(root, "homes");
    try {
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "auth.json"), validAuthJson);
      writeFileSync(join(source, "config.toml"), 'sandbox_mode = "danger-full-access"');
      writeFileSync(join(source, "AGENTS.md"), "controller authority briefing");
      const env = isolateCloudSubscriptionEnv({ ...process.env, CODEX_HOME: source }, "cloud-job", homes);
      expect(readFileSync(join(String(env.CODEX_HOME), "auth.json"), "utf8")).toBe(validAuthJson);
      expect(() => readFileSync(join(String(env.CODEX_HOME), "config.toml"), "utf8")).toThrow();
      expect(() => readFileSync(join(String(env.CODEX_HOME), "AGENTS.md"), "utf8")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("strips controller authority from an actual spawned specialist environment", () => {
    const env = isolateCloudSubscriptionEnv({
      ...process.env, CODEX_HOME: process.cwd(),
      JARVIS_GIT_REVIEW_RECEIPT_SECRET: "receipt-secret", CONVEX_URL: "https://control.example",
      JARVIS_GIT_REVIEW_RECEIPT_KEYRING: "keyring-secret-and-metadata",
      JARVIS_CLOUD_PROVIDER_PROBE_KEYRING: "provider-probe-verifier-secret",
      JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT: "signed-provider-probe-envelope",
      SANDBOX0_TOKEN: "sandbox-provider-secret",
      TRIGGER_SECRET_KEY: "trigger-secret", GITHUB_TOKEN: "github-secret",
    }, "spawn-scope");
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify({receipt:process.env.JARVIS_GIT_REVIEW_RECEIPT_SECRET,keyring:process.env.JARVIS_GIT_REVIEW_RECEIPT_KEYRING,providerProbeKeyring:process.env.JARVIS_CLOUD_PROVIDER_PROBE_KEYRING,providerProbeReceipt:process.env.JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT,providerToken:process.env.SANDBOX0_TOKEN,convex:process.env.CONVEX_URL,trigger:process.env.TRIGGER_SECRET_KEY,github:process.env.GITHUB_TOKEN,openai:process.env.OPENAI_API_KEY,codex:process.env.CODEX_API_KEY}))"], { env, encoding: "utf8" });
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ openai: "", codex: "" });
  });

  it("accepts only canonical base64 ChatGPT subscription auth", () => {
    expect(parseChatgptSubscriptionAuth(validAuthB64)).toEqual(validAuth);
    expect(() => parseChatgptSubscriptionAuth(`${validAuthB64}=`)).toThrow();
    expect(() => parseChatgptSubscriptionAuth(`${validAuthB64}\n`)).toThrow();
    expect(() => parseChatgptSubscriptionAuth(Buffer.from('{"auth_mode":"chatgpt","auth_mode":"chatgpt","tokens":{}}').toString("base64"))).toThrow();
    expect(() => parseChatgptSubscriptionAuth(Buffer.from(JSON.stringify({ ...validAuth, auth_mode: "chat-gpt" })).toString("base64"))).toThrow();
    expect(() => parseChatgptSubscriptionAuth(Buffer.from(JSON.stringify({ ...validAuth, api_key: "sk-live-never" })).toString("base64"))).toThrow();
    expect(() => parseChatgptSubscriptionAuth(Buffer.from(JSON.stringify({ ...validAuth, tokens: { ...validAuth.tokens, accessToken: "fuzzy" } })).toString("base64"))).toThrow();
    expect(() => parseChatgptSubscriptionAuth(Buffer.from(JSON.stringify({ ...validAuth, tokens: { ...validAuth.tokens, access_token: "sk-proj-api-key" } })).toString("base64"))).toThrow();
  });

  it("rejects legacy raw credential inputs before a Codex home is prepared", () => {
    vi.stubEnv("CODEX_ACCESS_TOKEN", "raw-access-token");
    expect(prepareSubscriptionEnv("codex").error).toBe("invalid Codex ChatGPT subscription auth");
    vi.stubEnv("CODEX_ACCESS_TOKEN", undefined);
    vi.stubEnv("CODEX_AUTH_JSON", validAuthJson);
    expect(prepareSubscriptionEnv("codex").error).toBe("invalid Codex ChatGPT subscription auth");
  });

  it("requires exact non-generating version and ChatGPT login receipts from either stream", () => {
    const calls: string[][] = [];
    const receipt = verifyCodexSubscriptionPreflight("/pinned/codex", prepareSubscriptionEnv("codex").env, (_bin, args) => {
      calls.push([...args]);
      return args[0] === "--version"
        ? { status: 0, stdout: "", stderr: "codex-cli 0.144.5\n" }
        : { status: 0, stdout: "Logged in using ChatGPT\n", stderr: "" };
    });
    expect(receipt.receipt).toEqual({ version: "codex-cli 0.144.5", loginStatus: "Logged in using ChatGPT" });
    expect(calls).toEqual([["--version"], ["login", "status"]]);
    const rejected = verifyCodexSubscriptionPreflight("/pinned/codex", prepareSubscriptionEnv("codex").env, () =>
      ({ status: 0, stdout: "codex-cli 0.144.5", stderr: "unexpected auth warning" }));
    expect(rejected.error).toBe("pinned Codex version receipt failed");
  });
});
