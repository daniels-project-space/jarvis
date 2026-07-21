import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROVIDER_NAMESPACE_FLAGS,
  PROVIDER_SANDBOX_SETUP,
  ProviderCandidateSandbox,
  createProviderToolSession,
  providerSandboxRuntimeAvailable,
  readProviderSandboxReceipt,
  safeProviderToolEnv,
  validateProviderSandboxReceipt,
  verifyProviderSandboxLifecycle,
  type ProviderSandboxObservation,
} from "./provider-command-sandbox";

const roots: string[] = [];
const tools = Object.fromEntries(["node", "npm", "npx", "git", "gh", "curl"].map((tool) => [
  tool,
  { available: true, version: `${tool}-synthetic` },
]));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(checkout: string, args: string[]): string {
  const home = join(checkout, "..", "controller-git-home");
  mkdirSync(home, { recursive: true });
  const result = spawnSync("/usr/bin/git", args, {
    cwd: checkout,
    env: {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      LANG: "C.UTF-8",
      NODE_ENV: "test",
    },
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
  return String(result.stdout);
}

function syntheticCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), "jarvis-provider-candidate-test-"));
  roots.push(root);
  const checkout = join(root, "candidate");
  mkdirSync(checkout);
  writeFileSync(join(checkout, "fixture.txt"), "candidate fixture\n", { mode: 0o600 });
  git(checkout, ["init", "--initial-branch=main"]);
  git(checkout, ["add", "--", "fixture.txt"]);
  git(checkout, [
    "-c", "user.name=JARVIS Sandbox", "-c", "user.email=sandbox.invalid",
    "commit", "-m", "synthetic candidate fixture",
  ]);
  return checkout;
}

function validObservation(nonce: string, issuedAt: number): ProviderSandboxObservation {
  return {
    protocol: 1,
    kind: "jarvis-provider-command-sandbox-preflight",
    nonce,
    issuedAt,
    selfPid: 1,
    numericPids: [1],
    capabilities: { effective: "0000000000000000", bounding: "0000000000000000", ambient: "0000000000000000", noNewPrivs: true },
    authority: {
      outsideCredentialReadable: false,
      outsideCredentialEchoed: false,
      outsideWriteBlocked: true,
      rootMemoryReadable: false,
      foreignCheckoutReadable: false,
      parentEnvironmentAuthorityVisible: false,
      outsideDirectoryFdVisible: false,
      workspaceWriteSucceeded: true,
      runtimeWriteBlocked: true,
      symlinkEscapeBlocked: true,
      unrelatedEtcReadable: false,
      requiredEtcReadable: true,
      devicesUsable: true,
      chrootBlocked: true,
      mountBlocked: true,
      capabilityRegainBlocked: true,
      gitMetadataWriteBlocked: true,
      gitRefWriteBlocked: true,
      gitHookWriteBlocked: true,
      gitCommitBlocked: true,
      freshHomeAndConfig: true,
      ambientSecretsAbsent: true,
      runtimeInjectionAbsent: true,
    },
    network: { policy: "target-egress-allowed-not-secret", namespace: "net:[4026531840]", expectedNamespace: "net:[4026531840]" },
    tools,
  };
}

function gitMetadataReceipt(checkout: string): Record<string, string> {
  return {
    head: git(checkout, ["rev-parse", "HEAD"]),
    config: git(checkout, ["config", "--local", "--list"]),
    refs: git(checkout, ["for-each-ref", "--format=%(refname)%00%(objectname)"]),
    hooks: readdirSync(join(checkout, ".git/hooks")).sort().join("\n"),
  };
}

describe("provider candidate command boundary", () => {
  it("resolves the complete fixed system toolchain before reporting runtime availability", () => {
    expect(providerSandboxRuntimeAvailable()).toBe(true);
  });

  it("uses exact fixed argv namespaces, a narrow chroot, private proc, and no nested Codex or shell-evaluated candidate text", () => {
    expect(PROVIDER_NAMESPACE_FLAGS).toEqual([
      "--user", "--map-root-user", "--mount", "--pid", "--fork", "--kill-child=SIGKILL",
      "--ipc", "--uts", "--propagation", "unchanged",
    ]);
    expect(PROVIDER_NAMESPACE_FLAGS).not.toContain("--net");
    expect(PROVIDER_SANDBOX_SETUP).toContain('/usr/bin/mount -t proc -o nosuid,nodev,noexec proc "$rootfs/proc"');
    expect(PROVIDER_SANDBOX_SETUP).toContain('/usr/bin/mount -o remount,bind,ro,nosuid,nodev "$rootfs/workspace/.git"');
    expect(PROVIDER_SANDBOX_SETUP).toContain('/usr/sbin/chroot "$rootfs"');
    expect(PROVIDER_SANDBOX_SETUP).toContain("/usr/bin/setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all");
    expect(PROVIDER_SANDBOX_SETUP).toContain("+noroot_locked,+no_setuid_fixup,+no_setuid_fixup_locked --no-new-privs");
    expect(PROVIDER_SANDBOX_SETUP).toContain("exec /usr/bin/env -i");
    expect(PROVIDER_SANDBOX_SETUP).toContain('"$@"\' provider-sandbox "$@"');
    expect(PROVIDER_SANDBOX_SETUP).not.toMatch(/\/controller\/codex|codex\s+sandbox|bubblewrap|sandbox-state|eval\s/i);
  });

  it("creates a fresh credentialless controller tool home and rejects config credentials, symlinks, and early cleanup", async () => {
    const ambient = {
      ...process.env,
      HOME: "/synthetic/controller-home",
      CODEX_HOME: "/synthetic/controller-codex",
      VAULT_ACCESS_TOKEN: "synthetic-vault",
      GITHUB_TOKEN: "synthetic-github",
      NODE_OPTIONS: "--require=/synthetic/implant.cjs",
      NPM_CONFIG_REGISTRY: "https://registry.invalid/?token=synthetic",
    };
    const session = createProviderToolSession(ambient);
    roots.push(session.root);
    const env = safeProviderToolEnv(ambient, session);
    expect(env.HOME).toBe(session.home);
    expect(env.HOME).not.toBe(ambient.HOME);
    expect(env.CODEX_HOME).toContain(session.root);
    expect(env.NPM_CONFIG_USERCONFIG).toContain(session.root);
    expect(env.GIT_CONFIG_GLOBAL).toContain(session.root);
    for (const key of ["VAULT_ACCESS_TOKEN", "GITHUB_TOKEN", "NODE_OPTIONS", "NPM_CONFIG_REGISTRY"]) {
      expect(env[key], key).toBeUndefined();
    }
    expect(readFileSync(String(env.NPM_CONFIG_USERCONFIG), "utf8")).toBe("");
    expect(readFileSync(String(env.GIT_CONFIG_GLOBAL), "utf8")).toBe("");

    const release = session.childStarted();
    expect(() => session.cleanup()).toThrow("before every child closes");
    release();
    await session.waitForChildren();
    writeFileSync(join(session.home, "access-token.txt"), "synthetic", { mode: 0o600 });
    expect(() => safeProviderToolEnv(ambient, session)).toThrow("credential-looking material");
    rmSync(join(session.home, "access-token.txt"));
    symlinkSync("/dev/null", join(session.home, "linked-config"));
    expect(() => safeProviderToolEnv(ambient, session)).toThrow("symlink");
    rmSync(join(session.home, "linked-config"));
    session.cleanup();
    expect(existsSync(session.root)).toBe(false);
  });

  it("rejects missing, empty, malformed, oversized, stale, replayed, schema-weakened, and authority-positive receipts", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-provider-receipt-test-"));
    roots.push(root);
    expect(() => readProviderSandboxReceipt(join(root, "missing.json"))).toThrow("missing");
    const empty = join(root, "empty.json");
    writeFileSync(empty, "", { mode: 0o600 });
    expect(() => readProviderSandboxReceipt(empty)).toThrow("empty");
    const oversized = join(root, "oversized.json");
    writeFileSync(oversized, "x".repeat(32 * 1024 + 1), { mode: 0o600 });
    expect(() => readProviderSandboxReceipt(oversized)).toThrow("oversized");
    const target = join(root, "target.json");
    const link = join(root, "link.json");
    writeFileSync(target, "{}", { mode: 0o600 });
    symlinkSync(target, link);
    expect(() => readProviderSandboxReceipt(link)).toThrow("unique regular file");

    const now = Date.now();
    const malformedNonce = randomBytes(32).toString("hex");
    expect(() => validateProviderSandboxReceipt({ raw: "{", nonce: malformedNonce, startedAt: now, closedAt: now }))
      .toThrow("malformed");
    const oversizedNonce = randomBytes(32).toString("hex");
    expect(() => validateProviderSandboxReceipt({ raw: "x".repeat(32 * 1024 + 1), nonce: oversizedNonce, startedAt: now, closedAt: now }))
      .toThrow("oversized");
    const staleNonce = randomBytes(32).toString("hex");
    expect(() => validateProviderSandboxReceipt({
      raw: JSON.stringify(validObservation(staleNonce, now - 60_000)),
      nonce: staleNonce,
      startedAt: now - 60_000,
      closedAt: now,
    })).toThrow("stale");

    const authorityKeys = Object.keys(validObservation("a".repeat(64), now).authority) as Array<keyof ProviderSandboxObservation["authority"]>;
    for (const key of authorityKeys) {
      const nonce = randomBytes(32).toString("hex");
      const receipt = validObservation(nonce, now);
      const safeValue = receipt.authority[key];
      const unsafe = { ...receipt, authority: { ...receipt.authority, [key]: !safeValue } };
      expect(() => validateProviderSandboxReceipt({ raw: JSON.stringify(unsafe), nonce, startedAt: now - 10, closedAt: now + 10 }), key)
        .toThrow("authority boundary failed");
    }

    const schemaNonce = randomBytes(32).toString("hex");
    const weakened = { ...validObservation(schemaNonce, now), unexpected: true };
    expect(() => validateProviderSandboxReceipt({ raw: JSON.stringify(weakened), nonce: schemaNonce, startedAt: now - 10, closedAt: now + 10 }))
      .toThrow("schema");
    const replayNonce = randomBytes(32).toString("hex");
    const replayRaw = JSON.stringify(validObservation(replayNonce, now));
    expect(validateProviderSandboxReceipt({ raw: replayRaw, nonce: replayNonce, startedAt: now - 10, closedAt: now + 10 }).nonce)
      .toBe(replayNonce);
    expect(() => validateProviderSandboxReceipt({ raw: replayRaw, nonce: replayNonce, startedAt: now - 10, closedAt: now + 10 }))
      .toThrow("replayed");
  });

  it("requires --ignore-scripts on every candidate npm ci before any runtime can start", async () => {
    const checkout = syntheticCheckout();
    const session = createProviderToolSession(process.env);
    roots.push(session.root);
    const sandbox = new ProviderCandidateSandbox({ checkout, baseEnv: process.env, session });
    await expect(sandbox.run({ command: "npm", args: ["ci"], timeoutMs: 1_000 }))
      .rejects.toThrow("must include --ignore-scripts");
    await sandbox.cleanup();
    session.cleanup();
  });

  it("proves real filesystem/proc/env/network/Git containment, argv safety, exact capability scope, CLOSE barriers, timeout reaping, redaction, and cleanup", async () => {
    const checkout = syntheticCheckout();
    const metadataBefore = gitMetadataReceipt(checkout);
    const ambient = {
      ...process.env,
      HOME: "/synthetic/controller-home",
      VAULT_ACCESS_TOKEN: "synthetic-controller-vault",
      GITHUB_TOKEN: "synthetic-controller-github",
      CODEX_ACCESS_TOKEN: "synthetic-controller-codex",
    };
    const session = createProviderToolSession(ambient);
    roots.push(session.root);
    const sandbox = new ProviderCandidateSandbox({ checkout, baseEnv: ambient, session });
    try {
      const observation = await sandbox.preflight();
      expect(observation.authority).toMatchObject(validObservation(observation.nonce, observation.issuedAt).authority);
      expect(observation.numericPids).toContain(observation.selfPid);
      expect(observation.network.namespace).toBe(observation.network.expectedNamespace);
      expect(observation.network.policy).toBe("target-egress-allowed-not-secret");
      expect(gitMetadataReceipt(checkout)).toEqual(metadataBefore);
      const snapshots = readdirSync(session.root).filter((name) => name.startsWith("runtime-etc-snapshot-"));
      expect(snapshots).toHaveLength(1);
      const snapshotRoot = join(session.root, snapshots[0]);
      expect(readdirSync(snapshotRoot).sort()).toEqual(["hosts", "nsswitch.conf", "resolv.conf"]);
      for (const name of readdirSync(snapshotRoot)) {
        const stat = lstatSync(join(snapshotRoot, name));
        expect(stat.isFile(), name).toBe(true);
        expect(stat.isSymbolicLink(), name).toBe(false);
        expect(stat.mode & 0o077, name).toBe(0);
        if (typeof process.getuid === "function") expect(stat.uid, name).toBe(process.getuid());
      }

      const commandDir = join(checkout, ".jarvis-provider-command-test");
      mkdirSync(commandDir);
      const script = join(commandDir, "argv.cjs");
      writeFileSync(script, `
const fs = require("node:fs");
fs.writeFileSync(process.argv[2], JSON.stringify({ argv: process.argv.slice(3), env: process.env }));
if (process.env.TRIGGER_ACCESS_TOKEN) process.stdout.write(process.env.TRIGGER_ACCESS_TOKEN);
`, { mode: 0o600 });
      const resultPath = join(commandDir, "result.json");
      const injectionMarker = join(checkout, "candidate-shell-injection");
      const adversarialArg = `literal;touch ${injectionMarker};$(id)`;
      const secret = `synthetic-target-${randomBytes(16).toString("hex")}`;
      const result = await sandbox.run({
        command: "node",
        args: [relative(checkout, script), relative(checkout, resultPath), adversarialArg],
        timeoutMs: 20_000,
        capability: { name: "TRIGGER_ACCESS_TOKEN", value: secret },
      });
      expect(result.code).toBe(0);
      expect(result.receipt).toMatchObject({
        candidateSandbox: true,
        executable: "node",
        argv: [relative(checkout, script), relative(checkout, resultPath), adversarialArg],
        closeObserved: true,
        timedOut: false,
        capability: "TRIGGER_ACCESS_TOKEN",
      });
      expect(result.out).not.toContain(secret);
      expect(result.out).toContain("[REDACTED]");
      expect(existsSync(injectionMarker)).toBe(false);
      const candidate = JSON.parse(readFileSync(resultPath, "utf8")) as { argv: string[]; env: Record<string, string> };
      expect(candidate.argv).toEqual([adversarialArg]);
      expect(candidate.env.TRIGGER_ACCESS_TOKEN).toBe(secret);
      expect(candidate.env.CONVEX_DEPLOY_KEY).toBeUndefined();
      expect(candidate.env.HOME).toBe("/home/provider");
      expect(candidate.env.VAULT_ACCESS_TOKEN).toBeUndefined();
      expect(candidate.env.GITHUB_TOKEN).toBeUndefined();
      expect(candidate.env.CODEX_ACCESS_TOKEN).toBeUndefined();

      await expect(verifyProviderSandboxLifecycle(sandbox)).resolves.toEqual({ ok: true });
      expect(readdirSync(session.root).some((name) => name.startsWith("rootfs-"))).toBe(false);
      expect(gitMetadataReceipt(checkout)).toEqual(metadataBefore);
      rmSync(commandDir, { recursive: true, force: true });
    } finally {
      await sandbox.cleanup();
      expect(readdirSync(session.root).some((name) => name.startsWith("runtime-etc-snapshot-"))).toBe(false);
      session.cleanup();
    }
    expect(existsSync(session.root)).toBe(false);
  });
});
