import type { CodexDynamicToolCall, CodexDynamicToolResult, CodexDynamicToolSpec } from "./codex-app-server";
import {
  CloudWorkspaceError,
  DEFAULT_WORKSPACE_LIMITS,
  validateSandboxOutput,
  type CloudWorkspace,
  type CloudWorkspaceProvider,
} from "./cloud-workspace";

export const CLOUD_REPOSITORY_TOOLS: CodexDynamicToolSpec[] = [
  {
    type: "function",
    name: "repository_exec",
    description: "Run one bounded command inside the isolated cloud repository workspace. No controller environment is inherited and network is denied by default.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        command: { type: "string", minLength: 1, maxLength: 16_000 },
        timeoutMs: { type: "integer", minimum: 1_000, maximum: DEFAULT_WORKSPACE_LIMITS.commandTimeoutMs },
      }, required: ["command"],
    },
  },
  {
    type: "function",
    name: "repository_validate",
    description:
      "Run one fixed validation command in the isolated deny-all repository workspace. " +
      "The caller cannot supply shell text; read-only work never exports workspace changes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["tests", "typecheck", "build"] },
        paths: {
          type: "array",
          maxItems: 24,
          items: { type: "string", minLength: 1, maxLength: 240 },
        },
      },
      required: ["kind"],
    },
  },
  {
    type: "function", name: "repository_read_file",
    description: "Read one bounded UTF-8 text file from the isolated cloud repository workspace.",
    inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string", minLength: 1, maxLength: 1_000 } }, required: ["path"] },
  },
  {
    type: "function", name: "repository_write_file",
    description: "Write one bounded UTF-8 text file inside the isolated cloud repository workspace.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { path: { type: "string", minLength: 1, maxLength: 1_000 }, content: { type: "string", maxLength: DEFAULT_WORKSPACE_LIMITS.maxFileBytes } },
      required: ["path", "content"],
    },
  },
  {
    type: "function", name: "repository_list_files",
    description: "List a bounded directory inside the isolated cloud repository workspace.",
    inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string", minLength: 1, maxLength: 1_000 } }, required: ["path"] },
  },
];

export type CloudRepositoryToolName =
  | "repository_exec"
  | "repository_validate"
  | "repository_read_file"
  | "repository_write_file"
  | "repository_list_files";

const CLOUD_REPOSITORY_TOOL_NAMES = new Set<CloudRepositoryToolName>([
  "repository_exec",
  "repository_validate",
  "repository_read_file",
  "repository_write_file",
  "repository_list_files",
]);

function isCloudRepositoryToolName(value: string): value is CloudRepositoryToolName {
  return CLOUD_REPOSITORY_TOOL_NAMES.has(value as CloudRepositoryToolName);
}

/**
 * The durable work order is the capability authority.  Dynamic-tool discovery
 * must expose no broader set than that authority, even for a read-only job.
 */
export function cloudRepositoryToolsForScope(scope: readonly string[]): CodexDynamicToolSpec[] {
  const allowed = new Set(scope.filter(isCloudRepositoryToolName));
  return CLOUD_REPOSITORY_TOOLS.filter((tool) => allowed.has(tool.name as CloudRepositoryToolName));
}

type ToolBridgeOptions = {
  signal?: AbortSignal;
  allowedToolScope: readonly string[];
  /** Controller-observed Git authority. The sandbox Git repository is a
   * credentialless transport re-materialization with a synthetic commit, so
   * its local HEAD must never be mistaken for the admitted source identity. */
  sourceBinding?: {
    sourceHeadSha: string;
    workspaceBaseSha: string;
  };
  beforeTool?: (call: CodexDynamicToolCall) => Promise<"running" | "stale" | "cancelled" | "steered">;
};

function result(text: string, success: boolean): CodexDynamicToolResult {
  return { contentItems: [{ type: "inputText", text }], success };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("tool arguments must be an object");
  return value as Record<string, unknown>;
}

const VALIDATION_TEST_PATH = /^(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@.-]+\.(?:test|spec)\.[cm]?[jt]sx?$/;

type ValidationCommand = {
  command: string;
  kind: "tests" | "typecheck" | "build";
  paths: string[];
};

function validationCommand(args: Record<string, unknown>): ValidationCommand {
  const kind = String(args.kind ?? "");
  if (kind === "typecheck") {
    if (args.paths !== undefined) throw new Error("typecheck does not accept paths");
    return { command: "npx tsc --noEmit --pretty false", kind, paths: [] };
  }
  if (kind === "build") {
    if (args.paths !== undefined) throw new Error("build does not accept paths");
    return { command: "npm run build", kind, paths: [] };
  }
  if (kind !== "tests" || !Array.isArray(args.paths) || args.paths.length < 1 || args.paths.length > 24) {
    throw new Error("tests require one to twenty-four bounded test paths");
  }
  const paths = args.paths.map((path) => String(path));
  if (new Set(paths).size !== paths.length || paths.some((path) =>
    path.length > 240 || path.startsWith("/") || path.startsWith("-")
    || path.split("/").includes("..") || !VALIDATION_TEST_PATH.test(path))) {
    throw new Error("test path is outside the admitted project-relative test-file grammar");
  }
  // Paths use a deliberately shell-inert grammar, so the resulting command
  // cannot smuggle flags, substitutions, separators, or traversal into the
  // fixed local Vitest invocation.
  // Vitest treats arguments after a bare `--` as runner passthrough rather
  // than file filters. The prior command therefore ran the entire repository
  // while claiming to run only the admitted files. This grammar already
  // rejects flags and shell metacharacters, so pass the exact filters directly.
  // JSON is parsed below into an aggregate-only receipt; raw test output never
  // crosses into the model response.
  return {
    command: `npx vitest run --reporter=json ${paths.join(" ")}`,
    kind: "tests",
    paths,
  };
}

function boundedCount(value: unknown): number | null {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 && count <= 1_000_000 ? count : null;
}

function sourceBindingReceipt(value: ToolBridgeOptions["sourceBinding"]) {
  if (!value
    || !/^[0-9a-f]{40}$/.test(value.sourceHeadSha)
    || !/^[0-9a-f]{40}$/.test(value.workspaceBaseSha)) return undefined;
  return {
    authority: "controller_bound_source_v1",
    sourceHeadSha: value.sourceHeadSha,
    workspaceBaseSha: value.workspaceBaseSha,
    exactSourceBound: value.sourceHeadSha === value.workspaceBaseSha,
    sandboxGitIdentity: "synthetic_credentialless_transport",
  } as const;
}

function validationTestReceipt(
  stdout: string,
  exitCode: number,
  durationMs: number,
  requestedPaths: string[],
  sourceBinding?: ToolBridgeOptions["sourceBinding"],
): { text: string; success: boolean } {
  try {
    const report = object(JSON.parse(stdout));
    const rawResults = Array.isArray(report.testResults) ? report.testResults : [];
    const files = requestedPaths.map((path) => {
      const matches = rawResults.filter((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
        const name = String((entry as Record<string, unknown>).name ?? "").replace(/\\/g, "/");
        return name === path || name.endsWith(`/${path}`);
      });
      const assertions = matches.flatMap((entry) => {
        const value = (entry as Record<string, unknown>).assertionResults;
        return Array.isArray(value) ? value : [];
      });
      const statuses = assertions.map((entry) =>
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? String((entry as Record<string, unknown>).status ?? "unknown")
          : "unknown",
      );
      return {
        path,
        reported: matches.length === 1,
        tests: statuses.length,
        passed: statuses.filter((status) => status === "passed").length,
        failed: statuses.filter((status) => status === "failed").length,
        pending: statuses.filter((status) => status === "pending" || status === "skipped" || status === "todo").length,
        unknown: statuses.filter((status) => !["passed", "failed", "pending", "skipped", "todo"].includes(status)).length,
      };
    });
    const expectedNames = new Set(requestedPaths);
    const unexpectedFiles = rawResults.filter((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return true;
      const name = String((entry as Record<string, unknown>).name ?? "").replace(/\\/g, "/");
      return ![...expectedNames].some((path) => name === path || name.endsWith(`/${path}`));
    }).length;
    const totals = {
      suites: boundedCount(report.numTotalTestSuites),
      passedSuites: boundedCount(report.numPassedTestSuites),
      failedSuites: boundedCount(report.numFailedTestSuites),
      tests: boundedCount(report.numTotalTests),
      passed: boundedCount(report.numPassedTests),
      failed: boundedCount(report.numFailedTests),
      pending: boundedCount(report.numPendingTests),
    };
    const observedTotals = files.reduce(
      (sum, file) => ({
        tests: sum.tests + file.tests,
        passed: sum.passed + file.passed,
        failed: sum.failed + file.failed,
        pending: sum.pending + file.pending,
      }),
      { tests: 0, passed: 0, failed: 0, pending: 0 },
    );
    const reportAccepted = rawResults.length <= requestedPaths.length
      && unexpectedFiles === 0
      && files.every((file) => file.reported && file.unknown === 0)
      && Object.values(totals).every((value) => value !== null)
      && totals.tests === observedTotals.tests
      && totals.passed === observedTotals.passed
      && totals.failed === observedTotals.failed
      && totals.pending === observedTotals.pending;
    const success = exitCode === 0
      && report.success === true
      && reportAccepted
      && totals.failed === 0
      && totals.failedSuites === 0;
    return {
      text: JSON.stringify({
        kind: "tests",
        success,
        exitCode,
        durationMs,
        reportAccepted,
        unexpectedFiles,
        totals,
        files,
        sourceBinding: sourceBindingReceipt(sourceBinding),
      }),
      success,
    };
  } catch {
    return {
      text: JSON.stringify({
        kind: "tests",
        success: false,
        exitCode,
        durationMs,
        reportAccepted: false,
        error: "validation report was not valid bounded Vitest JSON",
        sourceBinding: sourceBindingReceipt(sourceBinding),
      }),
      success: false,
    };
  }
}

export class CloudWorkspaceToolBridge {
  constructor(
    private readonly provider: CloudWorkspaceProvider,
    private readonly workspace: CloudWorkspace,
    private readonly options: ToolBridgeOptions,
  ) {}

  async invoke(call: CodexDynamicToolCall): Promise<CodexDynamicToolResult> {
    const allowed = cloudRepositoryToolsForScope(this.options.allowedToolScope);
    if (call.namespace !== null || !allowed.some((tool) => tool.name === call.tool)) {
      return result("Unknown cloud repository tool.", false);
    }
    try {
      const state = await this.options.beforeTool?.(call) ?? "running";
      if (state !== "running") throw new CloudWorkspaceError(this.provider.name, state === "cancelled" ? "cancelled" : "stale_attempt", `attempt is ${state}`, "deferred");
      const args = object(call.arguments);
      if (call.tool === "repository_exec") {
        const command = String(args.command ?? "");
        if (!command || command.length > 16_000) throw new Error("command is missing or oversized");
        const timeoutMs = Math.min(DEFAULT_WORKSPACE_LIMITS.commandTimeoutMs, Math.max(1_000, Number(args.timeoutMs ?? DEFAULT_WORKSPACE_LIMITS.commandTimeoutMs)));
        const execution = await this.provider.exec(this.workspace, {
          command, timeoutMs, maxOutputBytes: DEFAULT_WORKSPACE_LIMITS.maxOutputBytes, signal: this.options.signal,
        });
        const stdout = validateSandboxOutput(execution.stdout, DEFAULT_WORKSPACE_LIMITS.maxOutputBytes, this.provider.name);
        const stderr = validateSandboxOutput(execution.stderr, DEFAULT_WORKSPACE_LIMITS.maxOutputBytes, this.provider.name);
        return result(JSON.stringify({ exitCode: execution.exitCode, stdout, stderr, durationMs: execution.durationMs }), true);
      }
      if (call.tool === "repository_validate") {
        const validation = validationCommand(args);
        const execution = await this.provider.exec(this.workspace, {
          command: validation.command,
          timeoutMs: DEFAULT_WORKSPACE_LIMITS.commandTimeoutMs,
          maxOutputBytes: DEFAULT_WORKSPACE_LIMITS.maxOutputBytes,
          signal: this.options.signal,
        });
        if (validation.kind === "tests") {
          const receipt = validationTestReceipt(
            execution.stdout,
            execution.exitCode,
            execution.durationMs,
            validation.paths,
            this.options.sourceBinding,
          );
          return result(receipt.text, receipt.success);
        }
        const stdout = validateSandboxOutput(execution.stdout, DEFAULT_WORKSPACE_LIMITS.maxOutputBytes, this.provider.name);
        const stderr = validateSandboxOutput(execution.stderr, DEFAULT_WORKSPACE_LIMITS.maxOutputBytes, this.provider.name);
        return result(
          JSON.stringify({
            exitCode: execution.exitCode,
            stdout,
            stderr,
            durationMs: execution.durationMs,
            sourceBinding: sourceBindingReceipt(this.options.sourceBinding),
          }),
          execution.exitCode === 0,
        );
      }
      if (call.tool === "repository_read_file") {
        const bytes = await this.provider.readFile(this.workspace, String(args.path ?? ""), DEFAULT_WORKSPACE_LIMITS.maxFileBytes);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return result(validateSandboxOutput(text, DEFAULT_WORKSPACE_LIMITS.maxFileBytes, this.provider.name), true);
      }
      if (call.tool === "repository_write_file") {
        const content = String(args.content ?? "");
        const bytes = new TextEncoder().encode(content);
        await this.provider.writeFile(this.workspace, String(args.path ?? ""), bytes, DEFAULT_WORKSPACE_LIMITS.maxFileBytes);
        return result(JSON.stringify({ written: bytes.byteLength }), true);
      }
      const files = await this.provider.listFiles(this.workspace, String(args.path ?? "."), 2_000);
      return result(JSON.stringify(files), true);
    } catch (error) {
      const message = error instanceof CloudWorkspaceError ? `${error.code}: ${error.message}` : "invalid cloud repository tool request";
      return result(message, false);
    }
  }
}
