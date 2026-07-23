import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from "@ai-sdk/provider";

import {
  CodexAppServer,
  CodexRequestOutcomeUnknownError,
  validateCodexOutputSchema,
  type CodexAppServerOptions,
} from "../trigger/codex-app-server";
import { codexModelFor } from "../trigger/model-policy";
import {
  cleanupSubscriptionHome,
  consumeSubscriptionAuth,
  prepareSubscriptionEnv,
  resolveSubscriptionAgentBin,
  verifyCodexSubscriptionPreflight,
} from "../trigger/subscription-runtime";
import { backgroundSubscriptionValidityMs } from "../trigger/subscription-validity";
import {
  codexSubscriptionStreamParts,
  prepareCodexSubscriptionCall,
  type DecodedCodexSubscriptionResult,
} from "./codex-subscription-codec";

type ModelTier = "luna" | "terra" | "sol";

type AppServerInstance = Pick<CodexAppServer, "runTurn" | "stop">;

export interface CodexSubscriptionLanguageModelConfig {
  readonly modelTier: ModelTier;
  readonly turnTimeoutMs: number;
}

export interface CodexSubscriptionLanguageModelDependencies {
  readonly prepareSubscriptionEnv: typeof prepareSubscriptionEnv;
  readonly resolveSubscriptionAgentBin: typeof resolveSubscriptionAgentBin;
  readonly verifyCodexSubscriptionPreflight: typeof verifyCodexSubscriptionPreflight;
  readonly cleanupSubscriptionHome: typeof cleanupSubscriptionHome;
  readonly consumeSubscriptionAuth: typeof consumeSubscriptionAuth;
  readonly backgroundSubscriptionValidityMs: typeof backgroundSubscriptionValidityMs;
  readonly codexModelFor: typeof codexModelFor;
  readonly createAppServer: (
    bin: string,
    environment: NodeJS.ProcessEnv,
    turnTimeoutMs: number,
    options: CodexAppServerOptions,
  ) => AppServerInstance;
  readonly createControllerCwd: () => string;
  readonly removeControllerCwd: (cwd: string) => void;
  readonly createId: () => string;
  readonly now: () => Date;
  readonly prepareCodexSubscriptionCall: typeof prepareCodexSubscriptionCall;
  readonly codexSubscriptionStreamParts: typeof codexSubscriptionStreamParts;
  readonly validateCodexOutputSchema: typeof validateCodexOutputSchema;
}

const developerInstructions =
  "You are the Mastra supervisor reasoning model. You have no tools. Return exactly the requested structured envelope.";

const defaults: CodexSubscriptionLanguageModelDependencies = {
  prepareSubscriptionEnv,
  resolveSubscriptionAgentBin,
  verifyCodexSubscriptionPreflight,
  cleanupSubscriptionHome,
  consumeSubscriptionAuth,
  backgroundSubscriptionValidityMs,
  codexModelFor,
  createAppServer: (bin, environment, turnTimeoutMs, options) =>
    new CodexAppServer(bin, environment, turnTimeoutMs, options),
  createControllerCwd: () => {
    const cwd = mkdtempSync(join(tmpdir(), "mastra-codex-controller-"));
    chmodSync(cwd, 0o700);
    if ((statSync(cwd).mode & 0o777) !== 0o700 || readdirSync(cwd).length !== 0) {
      rmSync(cwd, { recursive: true, force: true });
      throw new Error("Unable to create an empty Codex controller directory.");
    }
    return cwd;
  },
  removeControllerCwd: (cwd) => {
    rmSync(cwd, { recursive: true, force: true });
  },
  createId: randomUUID,
  now: () => new Date(),
  prepareCodexSubscriptionCall,
  codexSubscriptionStreamParts,
  validateCodexOutputSchema,
};

function abortError(): Error {
  const error = new Error("The Codex subscription request was aborted.");
  error.name = "AbortError";
  return error;
}

function assertTimeout(turnTimeoutMs: number): void {
  if (
    !Number.isSafeInteger(turnTimeoutMs) ||
    turnTimeoutMs < 1 ||
    turnTimeoutMs > 300_000
  ) {
    throw new Error("Codex subscription turn timeout must be between 1 and 300000 ms.");
  }
}

function assertModelTier(modelTier: string): asserts modelTier is ModelTier {
  if (modelTier !== "luna" && modelTier !== "terra" && modelTier !== "sol") {
    throw new Error("Codex subscription model tier must be luna, terra, or sol.");
  }
}

interface SharedResult {
  readonly decoded: DecodedCodexSubscriptionResult;
  readonly responseId: string;
  readonly timestamp: Date;
  readonly modelId: string;
}

export function createCodexSubscriptionLanguageModel(
  config: CodexSubscriptionLanguageModelConfig,
  injected: Partial<CodexSubscriptionLanguageModelDependencies> = {},
): LanguageModelV2 {
  assertModelTier(config.modelTier);
  assertTimeout(config.turnTimeoutMs);
  const dependencies = { ...defaults, ...injected };
  const policy = dependencies.codexModelFor(config.modelTier);
  let invocation = 0;

  const run = async (options: LanguageModelV2CallOptions): Promise<SharedResult> => {
    const preparedCall = dependencies.prepareCodexSubscriptionCall(options);
    const outputSchema = dependencies.validateCodexOutputSchema(preparedCall.outputSchema);
    if (options.abortSignal?.aborted) {
      throw abortError();
    }

    const startedAt = dependencies.now();
    invocation += 1;
    const scopeId = dependencies
      .createId()
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 48);
    const scope = `mastra-${invocation}-${scopeId || "turn"}`;
    const acquisition = await dependencies.prepareSubscriptionEnv("codex", {
      scope,
      minimumValidityMs: dependencies.backgroundSubscriptionValidityMs(
        config.turnTimeoutMs,
      ),
    });

    let cwd: string | undefined;
    let server: AppServerInstance | undefined;
    let finalized = false;
    let aborted = false;
    let abortListenerRegistered = false;
    const finalize = (): void => {
      if (finalized) {
        return;
      }
      finalized = true;
      if (server !== undefined) {
        try {
          server.stop();
        } catch {
          // Cleanup must not replace the request outcome.
        }
      }
      if (cwd !== undefined) {
        try {
          dependencies.removeControllerCwd(cwd);
        } catch {
          // Cleanup must not replace the request outcome.
        }
      }
      try {
        dependencies.cleanupSubscriptionHome(acquisition.env);
      } catch {
        // Cleanup must not replace the request outcome.
      }
    };

    const onAbort = (): void => {
      aborted = true;
      finalize();
    };

    try {
      if (acquisition.error !== undefined) {
        throw new Error("Unable to acquire a Codex subscription credential.");
      }
      if (options.abortSignal?.aborted) {
        throw abortError();
      }

      options.abortSignal?.addEventListener("abort", onAbort, { once: true });
      abortListenerRegistered = options.abortSignal !== undefined;
      if (aborted || options.abortSignal?.aborted) {
        throw abortError();
      }

      const bin = dependencies.resolveSubscriptionAgentBin("codex");
      if (bin === null || bin === "") {
        throw new Error("The pinned Codex subscription binary is unavailable.");
      }
      if (aborted || options.abortSignal?.aborted) {
        throw abortError();
      }
      const preflight = dependencies.verifyCodexSubscriptionPreflight(
        bin,
        acquisition.env,
      );
      if (preflight.error !== undefined || preflight.receipt === undefined) {
        throw new Error("Codex subscription preflight failed.");
      }
      if (aborted || options.abortSignal?.aborted) {
        throw abortError();
      }
      cwd = dependencies.createControllerCwd();
      if (aborted || options.abortSignal?.aborted) {
        throw abortError();
      }
      server = dependencies.createAppServer(bin, acquisition.env, config.turnTimeoutMs, {
        controllerCwd: cwd,
        threadSandbox: "read-only",
        dynamicToolsOnly: true,
        dynamicTools: [],
        ephemeral: true,
        onAuthConsumed: () => dependencies.consumeSubscriptionAuth(acquisition.env),
        developerInstructions,
      });
      if (aborted || options.abortSignal?.aborted) {
        throw abortError();
      }
      const result = await server.runTurn({
        conversationId: dependencies.createId(),
        userText: preparedCall.promptText,
        history: [],
        contextBlock: "",
        preamble: "",
        modelTier: config.modelTier,
        allowTools: false,
        outputSchema,
        onDelta: () => {},
      });

      if (result.code !== 0) {
        throw new Error("Codex app-server turn failed.");
      }
      if (aborted || options.abortSignal?.aborted) {
        throw abortError();
      }

      return {
        decoded: preparedCall.decode(result.finalText, dependencies.createId),
        responseId: dependencies.createId(),
        timestamp: startedAt,
        modelId: policy.model,
      };
    } catch (error) {
      if (error instanceof CodexRequestOutcomeUnknownError) {
        throw error;
      }
      if (aborted || options.abortSignal?.aborted) {
        throw abortError();
      }
      throw error;
    } finally {
      if (abortListenerRegistered) {
        options.abortSignal?.removeEventListener("abort", onAbort);
      }
      finalize();
    }
  };

  return {
    specificationVersion: "v2",
    provider: "codex-subscription",
    modelId: policy.model,
    supportedUrls: {},
    async doGenerate(options) {
      const result = await run(options);
      return {
        ...result.decoded,
        response: {
          ...result.decoded.response,
          id: result.responseId,
          timestamp: result.timestamp,
          modelId: result.modelId,
        },
      };
    },
    async doStream(options) {
      const result = await run(options);
      const parts: LanguageModelV2StreamPart[] = dependencies.codexSubscriptionStreamParts(
        result.decoded,
        result.responseId,
        result.modelId,
        result.timestamp,
      );
      return {
        stream: new ReadableStream<LanguageModelV2StreamPart>({
          start(controller) {
            for (const part of parts) {
              controller.enqueue(part);
            }
            controller.close();
          },
        }),
      };
    },
  };
}
