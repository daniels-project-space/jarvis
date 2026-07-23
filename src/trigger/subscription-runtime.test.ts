import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cleanupSubscriptionHome,
  consumeSubscriptionAuth,
  isolateSubscriptionEnv,
  isolateCloudSubscriptionEnv,
  missingSubscriptionTools,
  parseChatgptSubscriptionAuth,
  prepareSubscriptionEnv,
  REQUIRED_AGENT_TOOLS,
  resolveSubscriptionAgentBin,
  verifyCodexSubscriptionPreflight,
} from "./subscription-runtime";
import { CONTROLLER_REFRESH_SENTINEL, canonicalAuthJson, consumerAuth } from "./subscription-auth";
import { CODEX_SESSION_SOURCE, CODEX_SESSION_SOURCE_ENV } from "./subscription-source";
import {
  DEFAULT_SUBSCRIPTION_VALIDITY_MS,
  CODEX_CONSUMER_REFRESH_GUARD_MS,
} from "./subscription-validity";

const validAuth = {
  OPENAI_API_KEY: null,
  auth_mode: "chatgpt",
  last_refresh: "2026-07-22T12:34:56.789Z",
  tokens: {
    access_token: "eyJ.access.subscription",
    refresh_token: "refresh_subscription",
    id_token: "eyJ.id.subscription",
    account_id: "acct_subscription",
  },
} as const;
const validAuthJson = JSON.stringify(validAuth);
const validAuthB64 = Buffer.from(validAuthJson, "utf8").toString("base64");

describe("subscription subprocess capability scope", () => {
  let consumerRoot: string;
  const controller = {
    acquire: vi.fn(async () => ({
      auth: consumerAuth(validAuth),
      version: 7,
      expiresAt: Date.now() + 60 * 60_000,
      fence: 3,
    })),
  };
  const prepare = () => prepareSubscriptionEnv("codex", {
    controller,
    root: consumerRoot,
    scope: "test",
  });

  beforeEach(() => {
    consumerRoot = mkdtempSync(join(tmpdir(), "jarvis-consumer-root-"));
    controller.acquire.mockClear();
    vi.stubEnv("CODEX_AUTH_JSON_B64", undefined);
    vi.stubEnv("CODEX_AUTH_JSON", undefined);
    vi.stubEnv("CODEX_ACCESS_TOKEN", undefined);
    vi.stubEnv(CODEX_SESSION_SOURCE_ENV, CODEX_SESSION_SOURCE);
  });
  afterEach(() => {
    rmSync(consumerRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("withholds dispatcher, worker and GitHub authority from specialists", async () => {
    vi.stubEnv("JARVIS_DISPATCH_TOKEN", "dispatch-capability");
    vi.stubEnv("JARVIS_WORKER_TOKEN", "worker-capability");
    vi.stubEnv("GITHUB_TOKEN", "github-capability");
    const specialist = (await prepare()).env;
    expect(specialist.JARVIS_DISPATCH_TOKEN).toBeUndefined();
    expect(specialist.JARVIS_WORKER_TOKEN).toBeUndefined();
    expect(specialist.GITHUB_TOKEN).toBeUndefined();
    expect(specialist.GH_TOKEN).toBeUndefined();
    expect(specialist[CODEX_SESSION_SOURCE_ENV]).toBeUndefined();
  });

  it("preserves the executable and network runtime without passing application authority", async () => {
    vi.stubEnv("PATH", process.env.PATH ?? "/usr/bin:/bin");
    vi.stubEnv("HTTPS_PROXY", "http://proxy.internal:8080");
    const specialist = (await prepare()).env;
    expect(specialist.PATH).toBe(process.env.PATH);
    expect(specialist.HTTPS_PROXY).toBe("http://proxy.internal:8080");
    expect(specialist.GIT_TERMINAL_PROMPT).toBe("0");
    expect(specialist.OPENAI_API_KEY).toBeUndefined();
    expect(specialist.CODEX_API_KEY).toBeUndefined();
    expect(specialist.CODEX_ACCESS_TOKEN).toBeUndefined();
  });

  it("finds every required specialist binary on the worker PATH", () => {
    expect(missingSubscriptionTools(process.env, REQUIRED_AGENT_TOOLS)).toEqual([]);
  });

  it("reports an honest missing-tool list for an over-sanitized PATH", () => {
    expect(missingSubscriptionTools({ PATH: "/definitely/missing" }, ["curl", "git"])).toEqual(["curl", "git"]);
  });

  it("keeps bridge authentication in the Trigger host instead of every Codex child", async () => {
    vi.stubEnv("JARVIS_DISPATCH_TOKEN", "dispatch-capability");
    vi.stubEnv("JARVIS_WORKER_TOKEN", "worker-capability");
    const supervisor = (await prepare()).env;
    expect(supervisor.JARVIS_DISPATCH_TOKEN).toBeUndefined();
    expect(supervisor.JARVIS_WORKER_TOKEN).toBeUndefined();
  });

  it("ships the pinned Codex CLI that Trigger conversation workers resolve", () => {
    expect(resolveSubscriptionAgentBin("codex")).toMatch(/codex/);
  });

  it("requests a safe default and refuses to start a consumer inside the CLI refresh guard", async () => {
    await prepare();
    expect(controller.acquire).toHaveBeenLastCalledWith({
      minimumValidityMs: DEFAULT_SUBSCRIPTION_VALIDITY_MS,
      afterUnauthorizedVersion: undefined,
    });
    controller.acquire.mockClear();
    const rejected = await prepareSubscriptionEnv("codex", {
      controller,
      root: consumerRoot,
      minimumValidityMs: CODEX_CONSUMER_REFRESH_GUARD_MS - 1,
    });
    expect(rejected.error).toContain("snapshot_stale");
    expect(controller.acquire).not.toHaveBeenCalled();
  });

  it("gives concurrent agents separate writable homes without a real refresh token", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-codex-test-"));
    const source = join(root, "source");
    const homes = join(root, "homes");
    try {
      mkdirSync(source, { recursive: true });
      const workerAuthJson = JSON.stringify(consumerAuth(validAuth));
      writeFileSync(join(source, "auth.json"), workerAuthJson);
      writeFileSync(join(source, "AGENTS.md"), "scoped briefing");
      const one = isolateSubscriptionEnv({ ...process.env, CODEX_HOME: source }, "job-one", homes);
      const two = isolateSubscriptionEnv({ ...process.env, CODEX_HOME: source }, "job-two", homes);
      expect(one.CODEX_HOME).not.toBe(two.CODEX_HOME);
      expect(readFileSync(join(String(one.CODEX_HOME), "AGENTS.md"), "utf8")).toBe("scoped briefing");
      expect(readFileSync(join(String(two.CODEX_HOME), "auth.json"), "utf8")).toBe(workerAuthJson);
      expect(readFileSync(join(String(two.CODEX_HOME), "auth.json"), "utf8")).not.toContain("refresh_subscription");
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
      const workerAuthJson = JSON.stringify(consumerAuth(validAuth));
      writeFileSync(join(source, "auth.json"), workerAuthJson);
      writeFileSync(join(source, "config.toml"), 'sandbox_mode = "danger-full-access"');
      writeFileSync(join(source, "AGENTS.md"), "controller authority briefing");
      const env = isolateCloudSubscriptionEnv({ ...process.env, CODEX_HOME: source }, "cloud-job", homes);
      expect(readFileSync(join(String(env.CODEX_HOME), "auth.json"), "utf8")).toBe(workerAuthJson);
      expect(() => readFileSync(join(String(env.CODEX_HOME), "config.toml"), "utf8")).toThrow();
      expect(() => readFileSync(join(String(env.CODEX_HOME), "AGENTS.md"), "utf8")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("unlinks auth and removes each exact prepared or isolated consumer home", async () => {
    const source = await prepare();
    const isolated = isolateCloudSubscriptionEnv(
      source.env,
      "cleanup-test",
      join(consumerRoot, "isolated"),
    );
    const sourceHome = String(source.env.CODEX_HOME);
    const isolatedHome = String(isolated.CODEX_HOME);

    expect(existsSync(join(sourceHome, "auth.json"))).toBe(true);
    expect(existsSync(join(isolatedHome, "auth.json"))).toBe(true);
    consumeSubscriptionAuth(isolated);
    expect(existsSync(join(isolatedHome, "auth.json"))).toBe(false);
    writeFileSync(join(isolatedHome, "runtime-state"), "disposable");

    expect(cleanupSubscriptionHome(isolated)).toBe(true);
    expect(cleanupSubscriptionHome(source.env)).toBe(true);
    expect(existsSync(isolatedHome)).toBe(false);
    expect(existsSync(sourceHome)).toBe(false);
  });

  it("refuses to remove an arbitrary directory that was not created as a consumer home", () => {
    const arbitrary = join(consumerRoot, "operator-files");
    mkdirSync(arbitrary, { recursive: true });
    writeFileSync(join(arbitrary, "auth.json"), "not a managed consumer");

    expect(cleanupSubscriptionHome({ CODEX_HOME: arbitrary })).toBe(false);
    expect(readFileSync(join(arbitrary, "auth.json"), "utf8")).toBe("not a managed consumer");
  });

  it("unlinks a replaced home symlink without following it", async () => {
    const source = await prepare();
    const home = String(source.env.CODEX_HOME);
    const external = mkdtempSync(join(tmpdir(), "jarvis-cleanup-canary-"));
    try {
      writeFileSync(join(external, "canary"), "must remain");
      rmSync(home, { recursive: true, force: true });
      symlinkSync(external, home, "dir");

      expect(cleanupSubscriptionHome(source.env)).toBe(true);
      expect(existsSync(home)).toBe(false);
      expect(readFileSync(join(external, "canary"), "utf8")).toBe("must remain");
    } finally {
      rmSync(external, { recursive: true, force: true });
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
      R2_PARENT_API_TOKEN: "parent-r2-api-token",
      R2_PARENT_ACCESS_KEY_ID: "parent-r2-access-id",
      AWS_SESSION_TOKEN: "temporary-r2-session-token",
      JARVIS_CODEX_SESSION_SOURCE: "vault-broker",
    }, "spawn-scope", join(consumerRoot, "spawn-homes"));
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify({receipt:process.env.JARVIS_GIT_REVIEW_RECEIPT_SECRET,keyring:process.env.JARVIS_GIT_REVIEW_RECEIPT_KEYRING,providerProbeKeyring:process.env.JARVIS_CLOUD_PROVIDER_PROBE_KEYRING,providerProbeReceipt:process.env.JARVIS_CLOUD_PROVIDER_PROBE_RECEIPT,providerToken:process.env.SANDBOX0_TOKEN,convex:process.env.CONVEX_URL,trigger:process.env.TRIGGER_SECRET_KEY,github:process.env.GITHUB_TOKEN,parentApi:process.env.R2_PARENT_API_TOKEN,parentId:process.env.R2_PARENT_ACCESS_KEY_ID,session:process.env.AWS_SESSION_TOKEN,source:process.env.JARVIS_CODEX_SESSION_SOURCE,openai:process.env.OPENAI_API_KEY,codex:process.env.CODEX_API_KEY}))"], { env, encoding: "utf8" });
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({});
  });

  it("accepts only canonical base64 ChatGPT subscription auth", () => {
    expect(parseChatgptSubscriptionAuth(validAuthB64)).toEqual(validAuth);
    expect(canonicalAuthJson(parseChatgptSubscriptionAuth(validAuthB64))).toBe(JSON.stringify(validAuth));
    expect(consumerAuth(validAuth)).toEqual({
      ...validAuth,
      tokens: { ...validAuth.tokens, refresh_token: CONTROLLER_REFRESH_SENTINEL },
    });
    expect(() => parseChatgptSubscriptionAuth(`${validAuthB64}=`)).toThrow();
    expect(() => parseChatgptSubscriptionAuth(`${validAuthB64}\n`)).toThrow();
    expect(() => parseChatgptSubscriptionAuth(Buffer.from('{"auth_mode":"chatgpt","auth_mode":"chatgpt","tokens":{}}').toString("base64"))).toThrow();
    expect(() => parseChatgptSubscriptionAuth(Buffer.from(JSON.stringify({ ...validAuth, auth_mode: "chat-gpt" })).toString("base64"))).toThrow();
    expect(() => parseChatgptSubscriptionAuth(Buffer.from(JSON.stringify({ ...validAuth, api_key: "sk-live-never" })).toString("base64"))).toThrow();
    expect(() => parseChatgptSubscriptionAuth(Buffer.from(JSON.stringify({ ...validAuth, OPENAI_API_KEY: "sk-live-never" })).toString("base64"))).toThrow();
    expect(() => parseChatgptSubscriptionAuth(Buffer.from(JSON.stringify({ ...validAuth, last_refresh: "2026-02-30T12:34:56Z" })).toString("base64"))).toThrow();
    expect(() => parseChatgptSubscriptionAuth(Buffer.from(JSON.stringify({ ...validAuth, last_refresh: "x".repeat(41) })).toString("base64"))).toThrow();
    expect(() => parseChatgptSubscriptionAuth(Buffer.from(JSON.stringify({ ...validAuth, tokens: { ...validAuth.tokens, accessToken: "fuzzy" } })).toString("base64"))).toThrow();
    expect(() => parseChatgptSubscriptionAuth(Buffer.from(JSON.stringify({ ...validAuth, tokens: { ...validAuth.tokens, access_token: "sk-proj-api-key" } })).toString("base64"))).toThrow();
  });

  it("ignores retired raw credential inputs in staged broker mode", async () => {
    vi.stubEnv("CODEX_ACCESS_TOKEN", "raw-access-token");
    vi.stubEnv("CODEX_AUTH_JSON", validAuthJson);
    vi.stubEnv("CODEX_AUTH_JSON_B64", validAuthB64);
    expect((await prepare()).error).toBeUndefined();
    expect(controller.acquire).toHaveBeenCalledTimes(1);
  });

  it("never invokes retired credential getters on the real prepare path", async () => {
    const retired = new Set([
      "CODEX_AUTH_JSON_B64", "CODEX_AUTH_JSON", "CODEX_ACCESS_TOKEN", "OPENAI_API_KEY",
    ]);
    const reads: string[] = [];
    const environment = new Proxy<Record<string, string | undefined>>({
      [CODEX_SESSION_SOURCE_ENV]: CODEX_SESSION_SOURCE,
      PATH: process.env.PATH,
    }, {
      get(target, property) {
        const name = String(property);
        if (retired.has(name)) throw new Error(`retired getter invoked: ${name}`);
        reads.push(name);
        return target[name];
      },
    });
    const result = await prepareSubscriptionEnv("codex", {
      controller,
      root: consumerRoot,
      scope: "getter-trap",
      environment,
    });
    expect(result.error).toBeUndefined();
    expect(reads).not.toEqual(expect.arrayContaining([...retired]));
  });

  it("rejects acquisition before the controller when the broker selector is absent", async () => {
    vi.stubEnv(CODEX_SESSION_SOURCE_ENV, undefined);
    const rejected = await prepare();
    expect(rejected.error).toContain("source_rejected");
    expect(rejected.env.CODEX_HOME).toBeUndefined();
    expect(rejected.env.HOME).toBeUndefined();
    expect(controller.acquire).not.toHaveBeenCalled();
  });

  it("requires exact non-generating version and ChatGPT login receipts from either stream", async () => {
    const calls: string[][] = [];
    const receipt = verifyCodexSubscriptionPreflight("/pinned/codex", (await prepare()).env, (_bin, args) => {
      calls.push([...args]);
      return args[0] === "--version"
        ? { status: 0, stdout: "", stderr: "codex-cli 0.144.5\n" }
        : { status: 0, stdout: "Logged in using ChatGPT\n", stderr: "" };
    });
    expect(receipt.receipt).toEqual({ version: "codex-cli 0.144.5", loginStatus: "Logged in using ChatGPT" });
    expect(calls).toEqual([["--version"], ["login", "status"]]);
    const rejected = verifyCodexSubscriptionPreflight("/pinned/codex", (await prepare()).env, () =>
      ({ status: 0, stdout: "codex-cli 0.144.5", stderr: "unexpected auth warning" }));
    expect(rejected.error).toBe("pinned Codex version receipt failed");
  });
});
