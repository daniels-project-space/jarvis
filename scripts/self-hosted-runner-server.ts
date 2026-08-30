import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PodmanSelfHostedRunnerBackend } from "../src/selfhost-runner/podman";
import { SelfHostedRunnerService, type RunnerLimits, type SelfHostedRunnerConfig } from "../src/selfhost-runner/runner";

const LOOPBACK = new Set(["127.0.0.1", "::1"]);
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const MAX_HTTP_BODY_BYTES = 25 * 1024 * 1024;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(name: string, fallback: number, min: number, max: number): number {
  const value = process.env[name] ? Number(process.env[name]) : fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} is outside its safe bound`);
  return value;
}

export function selfHostedRunnerServerConfig(): { bind: string; port: number; runner: SelfHostedRunnerConfig; workspaceTmpfsMb: number } {
  if (required("JARVIS_SELF_HOST_RUNNER_SERVER") !== "live") throw new Error("self-hosted runner server is not explicitly enabled");
  const bind = process.env.JARVIS_SELF_HOST_RUNNER_BIND?.trim() || "127.0.0.1";
  if (!LOOPBACK.has(bind)) throw new Error("self-hosted runner must bind to loopback behind an HTTPS tunnel");
  const token = required("JARVIS_SELF_HOST_RUNNER_TOKEN");
  if (!TOKEN.test(token)) throw new Error("JARVIS_SELF_HOST_RUNNER_TOKEN must be a 32+ character base64url bearer");
  const limits: RunnerLimits = {
    ttlMs: integer("JARVIS_SELF_HOST_RUNNER_TTL_MS", 55 * 60_000, 60_000, 55 * 60_000),
    commandTimeoutMs: integer("JARVIS_SELF_HOST_RUNNER_COMMAND_TIMEOUT_MS", 15 * 60_000, 1_000, 15 * 60_000),
    maxOutputBytes: integer("JARVIS_SELF_HOST_RUNNER_MAX_OUTPUT_BYTES", 2 * 1024 * 1024, 1_024, 2 * 1024 * 1024),
    maxFileBytes: integer("JARVIS_SELF_HOST_RUNNER_MAX_FILE_BYTES", 5 * 1024 * 1024, 1_024, 5 * 1024 * 1024),
    maxArchiveBytes: integer("JARVIS_SELF_HOST_RUNNER_MAX_ARCHIVE_BYTES", 25 * 1024 * 1024, 1_024, 25 * 1024 * 1024),
    cpu: integer("JARVIS_SELF_HOST_RUNNER_CPU", 2, 1, 2),
    memoryMb: integer("JARVIS_SELF_HOST_RUNNER_MEMORY_MB", 4_096, 512, 4_096),
  };
  return {
    bind,
    port: integer("JARVIS_SELF_HOST_RUNNER_PORT", 47_821, 1_024, 65_535),
    workspaceTmpfsMb: integer("JARVIS_SELF_HOST_RUNNER_TMPFS_MB", 1_024, 256, 4_096),
    runner: {
      token,
      stateDir: required("JARVIS_SELF_HOST_RUNNER_STATE_DIR"),
      image: required("JARVIS_SELF_HOST_RUNNER_IMAGE"),
      template: required("JARVIS_SELF_HOST_RUNNER_TEMPLATE"),
      runtime: required("JARVIS_SELF_HOST_RUNNER_RUNTIME"),
      limits,
      maxActiveWorkspaces: 1,
    },
  };
}

async function requestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of req) {
    const chunk = Buffer.from(value);
    size += chunk.byteLength;
    if (size > MAX_HTTP_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function serve(service: SelfHostedRunnerService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const abort = new AbortController();
  req.once("aborted", () => abort.abort());
  res.once("close", () => { if (!res.writableEnded) abort.abort(); });
  try {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await requestBody(req);
    const request = new Request(`http://runner.invalid${req.url ?? "/"}`, {
      method: req.method,
      headers: new Headers(req.headers as Record<string, string>),
      body: body ? new Uint8Array(body).buffer as ArrayBuffer : undefined,
      signal: abort.signal,
    });
    const response = await service.handle(request);
    res.statusCode = response.status;
    response.headers.forEach((value, name) => res.setHeader(name, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.statusCode = String(error).includes("body_too_large") ? 413 : 503;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify({ error: res.statusCode === 413 ? "body_too_large" : "runner_unavailable" }));
  }
}

export async function startSelfHostedRunnerServer(): Promise<void> {
  if (typeof process.getuid !== "function" || process.getuid() === 0) {
    throw new Error("self-hosted runner must run as a dedicated unprivileged OS user");
  }
  const configured = selfHostedRunnerServerConfig();
  const backend = new PodmanSelfHostedRunnerBackend({
    executable: "podman",
    image: configured.runner.image,
    workspaceTmpfsMb: configured.workspaceTmpfsMb,
    user: "65532:65532",
  });
  const service = new SelfHostedRunnerService(configured.runner, backend);
  await service.initialize();
  const server = createServer((req, res) => { void serve(service, req, res); });
  await new Promise<void>((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(configured.port, configured.bind, () => resolveReady());
  });
  process.stdout.write(JSON.stringify({ status: "ready", bind: configured.bind, port: configured.port, protocol: "1.0.0" }) + "\n");
  const stop = async () => {
    server.close();
    await service.shutdown();
    process.exit(0);
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void startSelfHostedRunnerServer().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "self-hosted runner failed"}\n`);
    process.exitCode = 1;
  });
}
