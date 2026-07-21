import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SPECIALIST_PROBE_PRLIMIT_ARGS,
  SPECIALIST_PROBE_PRLIMIT_COMMAND,
  buildSpecialistNamespaceProbeInvocation,
  readNamespaceProbeReceipt,
  validateNamespaceProbeReceipt,
  verifySpecialistSandboxIsolation,
  type NamespaceProbeLifecycleEvent,
} from "./specialist-sandbox";
import { buildPrivateProcNamespaceInvocation, PRIVATE_PROC_NAMESPACE_SETUP } from "./codex-launcher";

const roots: string[] = [];
const codexBin = realpathSync(join(process.cwd(), "node_modules/.bin/codex"));

function sandboxFixture() {
  const root = mkdtempSync(join(tmpdir(), "jarvis-sandbox-test-"));
  const controllerHome = realpathSync(homedir());
  const temporaryRoot = realpathSync(tmpdir());
  if (controllerHome === temporaryRoot || controllerHome.startsWith(`${temporaryRoot}/`)) {
    throw new Error("specialist test CODEX_HOME must model the non-temporary production wrapper home");
  }
  const codexHome = mkdtempSync(join(controllerHome, ".jarvis-specialist-test-codex-"));
  const codexHomeStat = lstatSync(codexHome);
  if (
    codexHomeStat.isSymbolicLink()
    || !codexHomeStat.isDirectory()
    || (typeof process.getuid === "function" && codexHomeStat.uid !== process.getuid())
  ) throw new Error("specialist test CODEX_HOME must be a fresh controller-owned directory");
  roots.push(root, codexHome);
  return {
    root,
    codexHome,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      HOME: codexHome,
      CODEX_HOME: codexHome,
      CODEX_ACCESS_TOKEN: "synthetic-never-live",
      VAULT_ACCESS_TOKEN: "synthetic-controller-sentinel",
      CONVEX_DEPLOY_KEY_JARVIS_CANONICAL: "synthetic-controller-sentinel",
    } satisfies NodeJS.ProcessEnv,
  };
}

function localNamespaceAvailable(): boolean {
  if (!existsSync("/usr/bin/unshare")) return false;
  const invocation = buildPrivateProcNamespaceInvocation({
    command: "/bin/true",
    args: [],
    cwd: "/tmp",
    env: { NODE_ENV: "test", PATH: process.env.PATH },
  });
  return spawnSync(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env,
  }).status === 0;
}

type FakeProbeBehavior = "valid" | "empty" | "malformed" | "stale" | "replayed" | "oversized" | "authority" | "timeout";

function fakeUnshare(root: string, behavior: FakeProbeBehavior, executable = true): string {
  const path = join(root, `fake-unshare-${behavior}-${Math.random().toString(16).slice(2)}.cjs`);
  writeFileSync(path, `#!/usr/bin/env node
const behavior = ${JSON.stringify(behavior)};
const value = (prefix) => (process.argv.find((arg) => arg.startsWith(prefix)) || "").slice(prefix.length);
const nonce = value("JARVIS_NAMESPACE_PROBE_NONCE=");
const receipt = {
  protocol: 1,
  kind: "jarvis-specialist-namespace-preflight",
  nonce: behavior === "replayed" ? "f".repeat(64) : nonce,
  issuedAt: Date.now() - (behavior === "stale" ? 60_000 : 0),
  controllerVisible: behavior === "authority",
  parentReadable: false,
  parentTokenVisible: false,
  foreignEnvironmentVisible: false,
  numericPids: [1],
  selfPid: 1,
  tools: Object.fromEntries(["node", "npm", "npx", "git", "gh", "curl"].map((tool) => [
    tool,
    { available: true, version: tool + "-synthetic" },
  ])),
};
if (behavior === "empty") process.exit(0);
if (behavior === "malformed") process.stdout.write("{");
else if (behavior === "oversized") process.stdout.write("x".repeat(16 * 1024 + 1));
else if (behavior === "timeout") setInterval(() => {}, 1_000);
else {
  const encoded = JSON.stringify(receipt);
  process.stdout.write(encoded.slice(0, Math.floor(encoded.length / 2)));
  setTimeout(() => process.stdout.write(encoded.slice(Math.floor(encoded.length / 2))), 10);
  if (behavior === "valid") setTimeout(() => undefined, 75);
}
`, { mode: executable ? 0o700 : 0o600 });
  chmodSync(path, executable ? 0o700 : 0o600);
  return path;
}

function expectReceiptReadOnlyAfterClose(events: NamespaceProbeLifecycleEvent[]): void {
  const fdClosed = events.indexOf("stdout-fd-closed");
  const close = events.indexOf("close");
  const read = events.indexOf("receipt-read");
  const cleanup = events.indexOf("receipt-cleanup");
  expect(fdClosed).toBeGreaterThan(events.indexOf("spawn"));
  expect(close).toBeGreaterThan(fdClosed);
  expect(read).toBeGreaterThan(close);
  expect(cleanup).toBeGreaterThan(close);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("specialist OS trust boundary", () => {
  it("constructs the exact user/PID/proc namespace before legacy Landlock", () => {
    const fixture = sandboxFixture();
    const invocation = buildSpecialistNamespaceProbeInvocation({
      codexBin,
      cwd: fixture.root,
      env: fixture.env,
      controllerPid: 4242,
    });

    expect(invocation.command).toBe("/usr/bin/unshare");
    expect(invocation.args.slice(0, 13)).toEqual([
      "--user",
      "--map-root-user",
      "--mount",
      "--pid",
      "--fork",
      "--kill-child=SIGKILL",
      "--propagation",
      "unchanged",
      "--",
      realpathSync("/bin/sh"),
      "-c",
      PRIVATE_PROC_NAMESPACE_SETUP,
      "sh",
    ]);
    expect(invocation.args).toContain(":read-only");
    expect(invocation.args).not.toContain(":workspace");
    expect(invocation.args).not.toContain(":workspace-write");
    expect(invocation.args).toContain("features.use_legacy_landlock=true");
    expect(invocation.args).toContain("JARVIS_NAMESPACE_CONTROLLER_PID=4242");
    expect(invocation.args.some((arg) => arg.startsWith("JARVIS_NAMESPACE_PROBE_RECEIPT="))).toBe(false);
    const codex = invocation.args.indexOf(codexBin);
    expect(invocation.args.slice(codex, codex + 8)).toEqual([
      codexBin,
      "sandbox",
      "-P",
      ":read-only",
      "-c",
      "features.use_legacy_landlock=true",
      "-C",
      fixture.root,
    ]);
    expect(invocation.env.CODEX_ACCESS_TOKEN).toMatch(/^eyJ/);
    expect(invocation.env.CODEX_ACCESS_TOKEN).not.toBe(fixture.env.CODEX_ACCESS_TOKEN);
    expect(invocation.env.CODEX_HOME).toBe(fixture.codexHome);
    expect(String(invocation.env.CODEX_HOME).startsWith(`${realpathSync(tmpdir())}/`)).toBe(false);
    expect(invocation.env.VAULT_ACCESS_TOKEN).toBeUndefined();
    expect(invocation.env.CONVEX_DEPLOY_KEY_JARVIS_CANONICAL).toBeUndefined();
    expect(invocation.args.join("\0")).not.toContain("synthetic-controller-sentinel");
    expect(invocation.args).not.toContain("--mount-proc=/proc");
    expect(SPECIALIST_PROBE_PRLIMIT_COMMAND).toBe("/usr/bin/prlimit");
    expect(SPECIALIST_PROBE_PRLIMIT_ARGS).toEqual(["--fsize=16384:16384", "--"]);
  });

  it("uses a canonical trusted identity when a successful tool wrapper emits no version output", () => {
    const fixture = sandboxFixture();
    const toolRoot = mkdtempSync(join(tmpdir(), "jarvis-controller-tool-path-"));
    roots.push(toolRoot);
    const emptyVersionTool = realpathSync("/usr/bin/test");
    const targets = {
      node: realpathSync(process.execPath),
      npm: emptyVersionTool,
      npx: emptyVersionTool,
      git: realpathSync("/usr/bin/git"),
      gh: realpathSync("/usr/bin/gh"),
      curl: realpathSync("/usr/bin/curl"),
    } as const;
    for (const [name, target] of Object.entries(targets)) {
      symlinkSync(target, join(toolRoot, name));
    }
    const invocation = buildSpecialistNamespaceProbeInvocation({
      codexBin,
      cwd: fixture.root,
      env: { ...fixture.env, PATH: toolRoot },
      controllerPid: 2_147_483_647,
    });
    const sourceIndex = invocation.args.lastIndexOf("-e");
    expect(sourceIndex).toBeGreaterThan(-1);
    const result = spawnSync(process.execPath, ["-e", invocation.args[sourceIndex + 1]!], {
      env: {
        PATH: toolRoot,
        HOME: fixture.root,
        NODE_ENV: "test",
        JARVIS_NAMESPACE_PROBE_NONCE: invocation.nonce,
        JARVIS_NAMESPACE_CONTROLLER_PID: "2147483647",
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      tools: Record<string, { available: boolean; version: string }>;
    };
    expect(receipt.tools.node).toEqual({
      available: true,
      version: spawnSync(process.execPath, ["--version"], { encoding: "utf8" }).stdout.trim(),
    });
    expect(receipt.tools.npm).toEqual({ available: true, version: emptyVersionTool });
    expect(receipt.tools.npx).toEqual({ available: true, version: emptyVersionTool });
    expect(receipt.tools.npm.version).toBe(realpathSync(join(toolRoot, "npm")));
    expect(receipt.tools.npm.version.length).toBeLessThanOrEqual(160);

    rmSync(join(toolRoot, "npm"), { force: true });
    writeFileSync(join(toolRoot, "npm"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const failed = spawnSync(process.execPath, ["-e", invocation.args[sourceIndex + 1]!], {
      env: {
        PATH: toolRoot,
        HOME: fixture.root,
        NODE_ENV: "test",
        JARVIS_NAMESPACE_PROBE_NONCE: invocation.nonce,
        JARVIS_NAMESPACE_CONTROLLER_PID: "2147483647",
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(failed.status, failed.stderr).toBe(0);
    const failedReceipt = JSON.parse(failed.stdout) as {
      tools: Record<string, { available: boolean; version: string }>;
    };
    expect(failedReceipt.tools.npm).toEqual({ available: false, version: "" });
  });

  it("proves the unsandboxed same-container /proc attack is real without emitting the sentinel", () => {
    const adversary = `
      const fs=require("node:fs");
      let value;
      try { value=fs.readFileSync("/proc/"+process.ppid+"/environ"); } catch { process.stdout.write("DENIED"); process.exit(); }
      process.stdout.write(value.includes(Buffer.from("VAULT_ACCESS_TOKEN=")) ? "EXPOSED" : "ABSENT");
    `;
    const parent = `
      const {spawnSync}=require("node:child_process");
      const result=spawnSync(process.execPath,["-e",${JSON.stringify(adversary)}],{env:{PATH:process.env.PATH},encoding:"utf8"});
      process.stdout.write(result.stdout);
    `;
    const result = spawnSync(process.execPath, ["-e", parent], {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        VAULT_ACCESS_TOKEN: "synthetic-never-live",
      },
      encoding: "utf8",
    });
    expect(result.stdout).toBe("EXPOSED");
    expect(result.stdout).not.toContain("synthetic-never-live");
  });

  it("runs the pinned CLI's supported read-only legacy-Landlock profile", () => {
    const fixture = sandboxFixture();
    const stdoutPath = join(fixture.root, "pinned-read-only.stdout");
    const stderrPath = join(fixture.root, "pinned-read-only.stderr");
    const stdout = openSync(stdoutPath, "wx", 0o600);
    const stderr = openSync(stderrPath, "wx", 0o600);
    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync(codexBin, [
        "sandbox",
        "-P",
        ":read-only",
        "-c",
        "features.use_legacy_landlock=true",
        "-C",
        fixture.root,
        "--",
        "/usr/bin/env",
        "-i",
        `PATH=${String(process.env.PATH ?? "")}`,
        `HOME=${fixture.root}`,
        "node",
        "-e",
        'process.stdout.write("PINNED_READ_ONLY_OK")',
      ], {
        cwd: fixture.root,
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH,
          HOME: fixture.codexHome,
          CODEX_HOME: fixture.codexHome,
        },
        stdio: ["ignore", stdout, stderr],
        timeout: 10_000,
      });
    } finally {
      closeSync(stdout);
      closeSync(stderr);
    }
    const stderrReceipt = readFileSync(stderrPath, "utf8");
    const stdoutReceipt = readFileSync(stdoutPath, "utf8");
    expect(result.status, stderrReceipt).toBe(0);
    expect(stderrReceipt).not.toContain("Refusing to create helper binaries under temporary dir");
    expect(stdoutReceipt).toBe("PINNED_READ_ONLY_OK");
  });

  it("fails closed when the namespace executable is unavailable", async () => {
    const fixture = sandboxFixture();
    const result = await verifySpecialistSandboxIsolation({
      codexBin,
      cwd: fixture.root,
      env: fixture.env,
      unshareBinary: join(fixture.root, "missing-unshare"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("namespace probe failed");
  });

  it("captures a bounded nonce receipt asynchronously and validates it only after CLOSE", async () => {
    const fixture = sandboxFixture();
    const events: NamespaceProbeLifecycleEvent[] = [];
    let settled = false;
    const pending = verifySpecialistSandboxIsolation({
      codexBin,
      cwd: fixture.root,
      env: fixture.env,
      unshareBinary: fakeUnshare(fixture.root, "valid"),
      onLifecycleEvent: (event) => events.push(event),
    }).finally(() => { settled = true; });
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 30));
    expect(settled).toBe(false);
    expect(events).not.toContain("receipt-read");
    const result = await pending;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.observation).toMatchObject({
        protocol: 1,
        controllerVisible: false,
        parentReadable: false,
        parentTokenVisible: false,
        foreignEnvironmentVisible: false,
      });
    }
    expect(events).toEqual([
      "spawn",
      "stdout-fd-closed",
      "close",
      "receipt-read",
      "receipt-validated",
      "receipt-cleanup",
    ]);
    expectReceiptReadOnlyAfterClose(events);
  });

  it.each(["empty", "malformed", "stale", "replayed", "oversized", "authority"] as const)(
    "fails closed on %s stdout receipts",
    async (behavior) => {
      const fixture = sandboxFixture();
      const events: NamespaceProbeLifecycleEvent[] = [];
      const result = await verifySpecialistSandboxIsolation({
        codexBin,
        cwd: fixture.root,
        env: fixture.env,
        unshareBinary: fakeUnshare(fixture.root, behavior),
        onLifecycleEvent: (event) => events.push(event),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/unavailable|failed/);
      expectReceiptReadOnlyAfterClose(events);
      expect(events).not.toContain("receipt-validated");
    },
  );

  it("kills a timed-out probe and still waits for CLOSE", async () => {
    const fixture = sandboxFixture();
    const startedAt = Date.now();
    const events: NamespaceProbeLifecycleEvent[] = [];
    const result = await verifySpecialistSandboxIsolation({
      codexBin,
      cwd: fixture.root,
      env: fixture.env,
      unshareBinary: fakeUnshare(fixture.root, "timeout"),
      probeTimeoutMs: 50,
      onLifecycleEvent: (event) => events.push(event),
    });
    expect(result.ok).toBe(false);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
    expect(events).toContain("timeout");
    expectReceiptReadOnlyAfterClose(events);
  });

  it("fails closed when fake unshare cannot execute and reads only after the outer child emits CLOSE", async () => {
    const fixture = sandboxFixture();
    const events: NamespaceProbeLifecycleEvent[] = [];
    const result = await verifySpecialistSandboxIsolation({
      codexBin,
      cwd: fixture.root,
      env: fixture.env,
      unshareBinary: fakeUnshare(fixture.root, "valid", false),
      probeTimeoutMs: 1_000,
      onLifecycleEvent: (event) => events.push(event),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("unavailable");
    expectReceiptReadOnlyAfterClose(events);
  });

  it("either proves the real pinned boundary or fails the worker closed on this kernel", async () => {
    const fixture = sandboxFixture();
    const result = await verifySpecialistSandboxIsolation({ codexBin, cwd: fixture.root, env: fixture.env });
    if (localNamespaceAvailable()) {
      expect(result.ok).toBe(true);
    } else {
      expect(result.ok).toBe(false);
    }
    if (result.ok) {
      expect(result.observation.controllerVisible).toBe(false);
      expect(result.observation.foreignEnvironmentVisible).toBe(false);
    } else {
      expect(result.reason).toMatch(/unavailable|failed/);
    }
  });

  it("rejects empty, malformed, oversized, stale, replayed, and schema-weakened receipt bytes", () => {
    const now = Date.now();
    const receiptRoot = mkdtempSync(join(tmpdir(), "jarvis-specialist-receipt-reader-"));
    roots.push(receiptRoot);
    expect(() => readNamespaceProbeReceipt(join(receiptRoot, "missing.json"))).toThrow("missing");
    const emptyPath = join(receiptRoot, "empty.json");
    writeFileSync(emptyPath, "", { mode: 0o600 });
    expect(() => readNamespaceProbeReceipt(emptyPath)).toThrow("empty");
    const oversizedPath = join(receiptRoot, "oversized.json");
    writeFileSync(oversizedPath, "x".repeat(16 * 1024 + 1), { mode: 0o600 });
    expect(() => readNamespaceProbeReceipt(oversizedPath)).toThrow("oversized");
    const targetPath = join(receiptRoot, "target.json");
    const symlinkPath = join(receiptRoot, "linked.json");
    writeFileSync(targetPath, "{}", { mode: 0o600 });
    symlinkSync(targetPath, symlinkPath);
    expect(() => readNamespaceProbeReceipt(symlinkPath)).toThrow("unique mode-0600 regular file");
    const validReceipt = (nonce: string, issuedAt = now) => JSON.stringify({
      protocol: 1,
      kind: "jarvis-specialist-namespace-preflight",
      nonce,
      issuedAt,
      controllerVisible: false,
      parentReadable: false,
      parentTokenVisible: false,
      foreignEnvironmentVisible: false,
      numericPids: [1],
      selfPid: 1,
      tools: Object.fromEntries(["node", "npm", "npx", "git", "gh", "curl"].map((tool) => [
        tool,
        { available: true, version: `${tool}-synthetic` },
      ])),
    });
    const malformedNonce = "1".repeat(64);
    expect(() => validateNamespaceProbeReceipt({
      raw: "",
      expectedNonce: malformedNonce,
      startedAt: now - 10,
      closedAt: now + 10,
    })).toThrow("empty");
    expect(() => validateNamespaceProbeReceipt({
      raw: "{",
      expectedNonce: malformedNonce,
      startedAt: now - 10,
      closedAt: now + 10,
    })).toThrow("malformed");
    expect(() => validateNamespaceProbeReceipt({
      raw: "x".repeat(16 * 1024 + 1),
      expectedNonce: "4".repeat(64),
      startedAt: now - 10,
      closedAt: now + 10,
    })).toThrow("oversized");
    const staleNonce = "2".repeat(64);
    expect(() => validateNamespaceProbeReceipt({
      raw: validReceipt(staleNonce, now - 60_000),
      expectedNonce: staleNonce,
      startedAt: now - 60_000,
      closedAt: now,
    })).toThrow("stale");
    const replayNonce = "3".repeat(64);
    const raw = validReceipt(replayNonce);
    expect(validateNamespaceProbeReceipt({ raw, expectedNonce: replayNonce, startedAt: now - 10, closedAt: now + 10 }).nonce)
      .toBe(replayNonce);
    expect(() => validateNamespaceProbeReceipt({ raw, expectedNonce: replayNonce, startedAt: now - 10, closedAt: now + 10 }))
      .toThrow("replayed");
    const schemaNonce = "5".repeat(64);
    const weakened = JSON.parse(validReceipt(schemaNonce)) as Record<string, unknown>;
    weakened.unexpected = true;
    expect(() => validateNamespaceProbeReceipt({
      raw: JSON.stringify(weakened),
      expectedNonce: schemaNonce,
      startedAt: now - 10,
      closedAt: now + 10,
    })).toThrow("schema");
  });
});
