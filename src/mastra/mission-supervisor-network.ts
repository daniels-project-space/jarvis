import { isProxy } from "node:util/types";

import type { LanguageModelV2 } from "@ai-sdk/provider";
import { Agent, type NetworkOptions } from "@mastra/core/agent";
import { createScorer } from "@mastra/core/evals";
import type { CompletionContext } from "@mastra/core/loop";
import { MockMemory } from "@mastra/core/memory";
import { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import { TEAM_BY_SLUG, type AgentSlug, type ModelTier } from "./team";
import {
  normalizeWorkstream,
  type ManagedWorkstream,
} from "./supervisor-routing";

export const SUPERVISOR_PLANNING_CONTEXT_MAX_BYTES = 24 * 1_024;
export const SUPERVISOR_PLANNING_GOAL_MAX_BYTES = 12 * 1_024;
export const SUPERVISOR_PLANNING_PROMPT_MAX_BYTES = 40 * 1_024;

const planningInputKeys = [
  "tickId",
  "missionId",
  "goal",
  "profile",
  "context",
  "repo",
  "desiredWorkstreams",
  "maxPrimitives",
] as const;

type SpecialistSlug = "paul" | "atlas" | "iris" | "maya" | "chloe" | "sentry";
type PlanningProfile = "short_fleet" | "durable_goal";
type TerminalReason = "desired_proposals_reached" | "primitive_cap_reached";
type PrimitiveType = "agent" | "workflow" | "tool" | "none";
type PlanningInputKey = (typeof planningInputKeys)[number];

export interface SupervisorPlanningTickInput {
  tickId: string;
  missionId: string;
  goal: string;
  profile: PlanningProfile;
  context?: string;
  repo?: string;
  desiredWorkstreams?: number;
  maxPrimitives?: number;
}

export interface SupervisorModelFactory {
  (tier: ModelTier): LanguageModelV2;
}

type SupervisorNetworkInputData = {
  task?: string;
  label?: string;
  repo?: string;
  model?: ModelTier;
  readonly?: boolean;
  risk?: "low" | "medium" | "high" | "consequential";
  primitiveId?: string;
  primitiveType?: PrimitiveType;
  iteration?: number;
};

type ProjectedSupervisorNetworkEvent = {
  type: string;
  payload?: {
    agentId?: string;
    primitiveId?: string;
    primitiveType?: PrimitiveType;
    toolName?: string;
    toolCallId?: string;
    iteration?: number;
    passed?: boolean;
    result?: string;
    reason?: string;
    inputData?: SupervisorNetworkInputData;
  };
};

export type SupervisorNetworkEvent = {
  type: string;
  primitiveId?: string;
  iteration?: number;
};

export type SupervisorPlanningTickResult = {
  kind: "ready_to_commit" | "no_proposals";
  tickId: string;
  missionId: string;
  proposals: ManagedWorkstream[];
  iterations: number;
  selectedAgents: Array<Exclude<AgentSlug, "jarvis">>;
  terminalReason: TerminalReason;
  networkStatus: "success";
};

type CopiedInput = {
  tickId: string;
  missionId: string;
  goal: string;
  profile: PlanningProfile;
  context?: string;
  repo?: string;
  desiredWorkstreams: number;
  maxPrimitives: number;
};

type PlanningRequestContext = {
  tickId: string;
  missionId: string;
  profile: PlanningProfile;
};

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/;
const allowedPlanningInputKeys = new Set<string>(planningInputKeys);
const utf8Encoder = new TextEncoder();
const proposalInput = z
  .object({
    task: z.string().trim().min(12).max(4_000),
    label: z.string().trim().min(3).max(80),
    repo: z.string().trim().min(1).max(500).optional(),
    requestedModel: z.enum(["luna", "terra", "sol"]).optional(),
    readonly: z.boolean().optional(),
    risk: z.enum(["low", "medium", "high", "consequential"]).optional(),
    acceptanceCriteria: z.array(z.string().trim().min(1).max(1_000)).min(1).max(8),
  })
  .strict();

function optionalBoundedString(
  value: unknown,
  key: "context" | "repo",
  maximumBytes: number,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TypeError(`Planning tick input ${key} is invalid`);
  }
  const trimmed = value.trim();
  if (utf8Encoder.encode(trimmed).byteLength > maximumBytes) {
    throw new TypeError(`Planning tick input ${key} is invalid`);
  }
  if (key === "repo" && trimmed.length === 0) {
    throw new TypeError("Planning tick input repo is invalid");
  }
  return trimmed || undefined;
}

function boundedInteger(value: unknown, key: string, minimum: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > 6
  ) {
    throw new TypeError(`Planning tick input ${key} is invalid`);
  }
  return value;
}

function copyInput(input: SupervisorPlanningTickInput): CopiedInput {
  if (input === null || typeof input !== "object") {
    throw new TypeError("Planning tick input must be an ordinary object");
  }
  if (isProxy(input)) {
    throw new TypeError("Planning tick input must not be a proxy");
  }
  if (Array.isArray(input)) {
    throw new TypeError("Planning tick input must be an ordinary object");
  }

  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Planning tick input must be an ordinary object");
  }

  const descriptors = new Map<PlanningInputKey, PropertyDescriptor>();
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowedPlanningInputKeys.has(key)) {
      throw new TypeError("Planning tick input contains an unknown property");
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor !== undefined) {
      descriptors.set(key as PlanningInputKey, descriptor);
    }
  }

  for (const descriptor of descriptors.values()) {
    if (!("value" in descriptor)) {
      throw new TypeError("Planning tick input must not contain accessor properties");
    }
  }
  for (const descriptor of descriptors.values()) {
    if (
      descriptor.enumerable !== true ||
      descriptor.configurable !== true ||
      descriptor.writable !== true
    ) {
      throw new TypeError("Planning tick input properties must be ordinary data properties");
    }
  }

  const required = ["tickId", "missionId", "goal", "profile"] as const;
  for (const key of required) {
    if (!descriptors.has(key)) {
      throw new TypeError(`Planning tick input must provide data property ${key}`);
    }
  }

  const value = (key: PlanningInputKey): unknown => descriptors.get(key)?.value;
  const tickId = value("tickId");
  const missionId = value("missionId");
  const goalValue = value("goal");
  const profile = value("profile");

  if (typeof tickId !== "string" || !safeId.test(tickId)) {
    throw new TypeError("Planning tick input tickId is invalid");
  }
  if (typeof missionId !== "string" || !safeId.test(missionId)) {
    throw new TypeError("Planning tick input missionId is invalid");
  }
  if (typeof goalValue !== "string") {
    throw new TypeError("Planning tick input goal is invalid");
  }
  const goal = goalValue.trim();
  if (
    goal.length < 12 ||
    utf8Encoder.encode(goal).byteLength > SUPERVISOR_PLANNING_GOAL_MAX_BYTES
  ) {
    throw new TypeError("Planning tick input goal is invalid");
  }
  if (profile !== "short_fleet" && profile !== "durable_goal") {
    throw new TypeError("Planning tick input profile is invalid");
  }

  const desiredWorkstreams =
    boundedInteger(
      value("desiredWorkstreams"),
      "desiredWorkstreams",
      profile === "short_fleet" ? 1 : 2,
    ) ?? (profile === "short_fleet" ? 1 : 2);
  const maxPrimitives = boundedInteger(value("maxPrimitives"), "maxPrimitives", 1) ?? 6;
  if (desiredWorkstreams > maxPrimitives) {
    throw new TypeError(
      "Planning tick input desiredWorkstreams cannot exceed maxPrimitives",
    );
  }

  return {
    tickId,
    missionId,
    goal,
    profile,
    context: optionalBoundedString(
      value("context"),
      "context",
      SUPERVISOR_PLANNING_CONTEXT_MAX_BYTES,
    ),
    repo: optionalBoundedString(value("repo"), "repo", 500),
    desiredWorkstreams,
    maxPrimitives,
  };
}

function planningPrompt(copied: CopiedInput): string {
  const prompt = [
    `Planning goal: ${copied.goal}`,
    copied.context ? `Context: ${copied.context}` : "",
    copied.repo ? `Repository hint: ${copied.repo}` : "",
    `Need ${copied.desiredWorkstreams} independent workstream proposal(s), with a hard cap of ${copied.maxPrimitives} planning primitives.`,
  ]
    .filter(Boolean)
    .join("\n");
  if (
    utf8Encoder.encode(prompt).byteLength >
    SUPERVISOR_PLANNING_PROMPT_MAX_BYTES
  ) {
    throw new TypeError("Planning tick prompt exceeds its byte bound");
  }
  return prompt;
}

function safeRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return undefined;
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      descriptor.configurable !== true ||
      descriptor.writable !== true
    ) {
      return undefined;
    }
  }
  return value as Record<string, unknown>;
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function boundedText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, maximum) : undefined;
}

function boundedIteration(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 1_000_000
    ? value
    : undefined;
}

function primitiveType(value: unknown): PrimitiveType | undefined {
  return value === "agent" || value === "workflow" || value === "tool" || value === "none"
    ? value
    : undefined;
}

function projectInputData(value: unknown): SupervisorNetworkInputData | undefined {
  const record = safeRecord(value);
  if (!record) {
    return undefined;
  }

  const projected: SupervisorNetworkInputData = {};
  const task = boundedText(ownValue(record, "task"), 240);
  const label = boundedText(ownValue(record, "label"), 80);
  const repo = boundedText(ownValue(record, "repo"), 160);
  const model = ownValue(record, "requestedModel");
  const readonly = ownValue(record, "readonly");
  const risk = ownValue(record, "risk");
  const selectedPrimitiveId = boundedText(ownValue(record, "primitiveId"), 160);
  const selectedPrimitiveType = primitiveType(ownValue(record, "primitiveType"));
  const iteration = boundedIteration(ownValue(record, "iteration"));

  if (task !== undefined) projected.task = task;
  if (label !== undefined) projected.label = label;
  if (repo !== undefined) projected.repo = repo;
  if (model === "luna" || model === "terra" || model === "sol") projected.model = model;
  if (typeof readonly === "boolean") projected.readonly = readonly;
  if (risk === "low" || risk === "medium" || risk === "high" || risk === "consequential") {
    projected.risk = risk;
  }
  if (selectedPrimitiveId !== undefined) projected.primitiveId = selectedPrimitiveId;
  if (selectedPrimitiveType !== undefined) projected.primitiveType = selectedPrimitiveType;
  if (iteration !== undefined) projected.iteration = iteration;

  return Object.keys(projected).length > 0 ? projected : undefined;
}

type ProjectedPayload = NonNullable<ProjectedSupervisorNetworkEvent["payload"]>;

function projectPayload(value: unknown, depth = 0): ProjectedPayload | undefined {
  const record = safeRecord(value);
  if (!record) {
    return undefined;
  }

  const projected: ProjectedPayload = {};
  const agentId = boundedText(ownValue(record, "agentId"), 160);
  const selectedPrimitiveId = boundedText(ownValue(record, "primitiveId"), 160);
  const selectedPrimitiveType = primitiveType(ownValue(record, "primitiveType"));
  const toolName = boundedText(ownValue(record, "toolName"), 160);
  const toolCallId = boundedText(ownValue(record, "toolCallId"), 160);
  const iteration = boundedIteration(ownValue(record, "iteration"));
  const passed = ownValue(record, "passed");
  const result = boundedText(ownValue(record, "result"), 240);
  const reason = boundedText(ownValue(record, "reason"), 240);

  if (agentId !== undefined) projected.agentId = agentId;
  if (selectedPrimitiveId !== undefined) projected.primitiveId = selectedPrimitiveId;
  if (selectedPrimitiveType !== undefined) projected.primitiveType = selectedPrimitiveType;
  if (toolName !== undefined) projected.toolName = toolName;
  if (toolCallId !== undefined) projected.toolCallId = toolCallId;
  if (iteration !== undefined) projected.iteration = iteration;
  if (typeof passed === "boolean") projected.passed = passed;
  if (result !== undefined) projected.result = result;
  if (reason !== undefined) projected.reason = reason;

  const directInput =
    projectInputData(ownValue(record, "inputData")) ??
    projectInputData(ownValue(record, "args")) ??
    projectInputData(ownValue(record, "input"));
  if (directInput !== undefined) {
    projected.inputData = directInput;
  } else {
    const args = safeRecord(ownValue(record, "args"));
    const nestedArgs = args && projectInputData(ownValue(args, "args"));
    if (nestedArgs !== undefined) {
      projected.inputData = nestedArgs;
    }
  }

  if (depth === 0) {
    const nested = projectPayload(ownValue(record, "payload"), 1);
    if (nested !== undefined) {
      projected.agentId ??= nested.agentId;
      projected.primitiveId ??= nested.primitiveId;
      projected.primitiveType ??= nested.primitiveType;
      projected.toolName ??= nested.toolName;
      projected.toolCallId ??= nested.toolCallId;
      projected.iteration ??= nested.iteration;
      projected.passed ??= nested.passed;
      projected.result ??= nested.result;
      projected.reason ??= nested.reason;
      projected.inputData ??= nested.inputData;
    }
  }

  return Object.keys(projected).length > 0 ? projected : undefined;
}

function boundedEvent(value: unknown): SupervisorNetworkEvent | undefined {
  const event = safeRecord(value);
  if (!event) {
    return undefined;
  }
  const type = boundedText(ownValue(event, "type"), 120);
  if (!type) {
    return undefined;
  }
  const payload = projectPayload(ownValue(event, "payload"));
  const projected: SupervisorNetworkEvent = { type };
  if (payload?.primitiveId !== undefined) {
    projected.primitiveId = payload.primitiveId;
  } else if (payload?.inputData?.primitiveId !== undefined) {
    projected.primitiveId = payload.inputData.primitiveId;
  }
  if (payload?.iteration !== undefined) {
    projected.iteration = payload.iteration;
  } else if (payload?.inputData?.iteration !== undefined) {
    projected.iteration = payload.inputData.iteration;
  }
  return projected;
}

function signalReason(signal: AbortSignal, fallback: string): unknown {
  return signal.reason ?? new Error(fallback);
}

function withPlanningAbort(
  model: LanguageModelV2,
  planningSignal: AbortSignal,
): LanguageModelV2 {
  const abortSignalFor = (callSignal: AbortSignal | undefined): AbortSignal =>
    callSignal && callSignal !== planningSignal
      ? AbortSignal.any([planningSignal, callSignal])
      : planningSignal;

  return {
    specificationVersion: "v2",
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate(call) {
      return model.doGenerate({
        ...call,
        abortSignal: abortSignalFor(call.abortSignal),
      });
    },
    doStream(call) {
      return model.doStream({
        ...call,
        abortSignal: abortSignalFor(call.abortSignal),
      });
    },
  };
}

function enforcePlanningPolicy(workstream: ManagedWorkstream): ManagedWorkstream {
  if (!workstream.approvalRequired && workstream.risk !== "consequential") {
    return workstream;
  }
  return {
    ...workstream,
    readonly: true,
    approvalRequired: true,
    risk: "consequential",
  };
}

export async function runSupervisorPlanningNetwork(
  input: SupervisorPlanningTickInput,
  options: {
    modelFor: SupervisorModelFactory;
    onEvent?: (event: SupervisorNetworkEvent) => void | Promise<void>;
    abortSignal?: AbortSignal;
  },
): Promise<SupervisorPlanningTickResult> {
  const copied = copyInput(input);
  const prompt = planningPrompt(copied);
  const modelFor = options.modelFor;
  const onEvent = options.onEvent;
  const externalSignal = options.abortSignal;

  if (typeof modelFor !== "function") {
    throw new TypeError("Planning tick model factory is invalid");
  }
  if (onEvent !== undefined && typeof onEvent !== "function") {
    throw new TypeError("Planning tick event handler is invalid");
  }
  if (externalSignal?.aborted) {
    throw signalReason(externalSignal, "Planning tick aborted");
  }

  const providerAbort = new AbortController();
  const capError = new Error("Planning primitive cap exceeded");
  const forwardExternalAbort = () => {
    providerAbort.abort(
      externalSignal
        ? signalReason(externalSignal, "Planning tick aborted")
        : new Error("Planning tick aborted"),
    );
  };
  let externalListenerAttached = false;

  try {
    if (externalSignal) {
      externalSignal.addEventListener("abort", forwardExternalAbort, { once: true });
      externalListenerAttached = true;
      if (externalSignal.aborted) {
        forwardExternalAbort();
        throw signalReason(externalSignal, "Planning tick aborted");
      }
    }

    const memory = new MockMemory({ options: { observationalMemory: false } });
    const ledger: ManagedWorkstream[] = [];
    const selectedAgents: SpecialistSlug[] = [];
    let observedIterations = 0;
    let closureReason: TerminalReason | undefined;
    let capViolation: Error | undefined;
    let eventDeliveryFailed = false;
    let eventDeliveryError: unknown;

    const specialist = (slug: SpecialistSlug) => {
      const manifest = TEAM_BY_SLUG[slug];
      const proposeWorkstream = createTool({
        id: "proposeWorkstream",
        description:
          "Submit exactly one bounded workstream proposal. The owner is always the specialist running this tool.",
        inputSchema: proposalInput,
        execute: async (inputData, context) => {
          if (externalSignal?.aborted) {
            throw signalReason(externalSignal, "Planning tick aborted");
          }
          if (context.abortSignal?.aborted) {
            throw signalReason(context.abortSignal, "Planning tick aborted");
          }
          if (
            ledger.length >= copied.desiredWorkstreams ||
            ledger.length >= copied.maxPrimitives
          ) {
            return "rejected: planning tick has reached its proposal bound";
          }

          const normalized = enforcePlanningPolicy(
            normalizeWorkstream({
              task: inputData.task,
              label: inputData.label,
              repo: inputData.repo ?? copied.repo,
              model: inputData.requestedModel,
              readonly: inputData.readonly,
              risk: inputData.risk,
              acceptanceCriteria: inputData.acceptanceCriteria,
              agentId: slug,
            }),
          );
          const duplicateKey = `${normalized.agentId}:${normalized.repo ?? ""}:${normalized.task
            .trim()
            .toLowerCase()}`;
          const duplicate = ledger.some(
            (proposal) =>
              `${proposal.agentId}:${proposal.repo ?? ""}:${proposal.task.trim().toLowerCase()}` ===
              duplicateKey,
          );
          if (duplicate) {
            return "deduplicated: an equivalent proposal is already recorded";
          }

          ledger.push(normalized);
          if (!selectedAgents.includes(slug)) {
            selectedAgents.push(slug);
          }
          return `accepted: ${normalized.label}`;
        },
      });

      return new Agent({
        id: slug,
        name: manifest.name,
        description: manifest.description,
        instructions: `${manifest.instructions}

You are a planning specialist. Call proposeWorkstream exactly once before writing any final response.
Then briefly state whether the proposal was accepted, deduplicated, or rejected. Never claim that work was executed.`,
        model: withPlanningAbort(modelFor(manifest.defaultModel), providerAbort.signal),
        memory,
        tools: { proposeWorkstream },
        defaultOptions: {
          maxSteps: 2,
          prepareStep: ({ stepNumber }) => ({
            activeTools: stepNumber === 0 ? ["proposeWorkstream"] : [],
            toolChoice: stepNumber === 0 ? "required" : "none",
          }),
          onIterationComplete: ({ iteration }) =>
            iteration >= 2 ? { continue: false } : undefined,
        },
      });
    };

    const paul = specialist("paul");
    const atlas = specialist("atlas");
    const iris = specialist("iris");
    const maya = specialist("maya");
    const chloe = specialist("chloe");
    const sentry = specialist("sentry");
    const jarvisManifest = TEAM_BY_SLUG.jarvis;

    const terminalScorer = createScorer<CompletionContext, string>({
      id: "supervisor-planning-terminal",
      description:
        "Finish only when the requested proposal count is accepted or the exact primitive cap is reached.",
    })
      .generateScore(({ run }) => {
        const iteration = run.input?.iteration;
        const completedPrimitives =
          typeof iteration === "number" && Number.isInteger(iteration) ? iteration + 1 : 0;
        if (ledger.length >= copied.desiredWorkstreams) {
          closureReason = "desired_proposals_reached";
          return 1;
        }
        if (completedPrimitives >= copied.maxPrimitives) {
          closureReason = "primitive_cap_reached";
          return 1;
        }
        return 0;
      })
      .generateReason(({ score }) =>
        score === 1
          ? closureReason === "desired_proposals_reached"
            ? "The requested number of independent proposals has been accepted."
            : "The exact planning primitive cap has been reached."
          : "More independent planning proposals are required within the remaining cap.",
      );

    const jarvis = new Agent({
      id: "jarvis",
      name: jarvisManifest.name,
      description: jarvisManifest.description,
      instructions: `${jarvisManifest.instructions}

Route each planning iteration to exactly one of Paul, Atlas, Iris, Maya, Chloe, or Sentry.
Choose work that is independent of already accepted work, stays within repository and project boundaries,
and stop once enough independent workstreams have been proposed. You have no execution authority and no direct tools.`,
      model: withPlanningAbort(modelFor(jarvisManifest.defaultModel), providerAbort.signal),
      memory,
      agents: { paul, atlas, iris, maya, chloe, sentry },
    });

    const requestContext = new RequestContext<PlanningRequestContext>([
      ["tickId", copied.tickId],
      ["missionId", copied.missionId],
      ["profile", copied.profile],
    ]);
    const networkOptions: NetworkOptions = {
      maxSteps: Math.max(1, copied.maxPrimitives - 1),
      requestContext,
      completion: {
        scorers: [terminalScorer],
        strategy: "all",
        parallel: false,
        timeout: 1_000,
        suppressFeedback: true,
      },
      onIterationComplete: ({ iteration }) => {
        const completedPrimitives = iteration + 1;
        observedIterations = Math.max(observedIterations, completedPrimitives);
        if (completedPrimitives > copied.maxPrimitives) {
          capViolation ??= capError;
        }
      },
    };

    if (externalSignal?.aborted) {
      throw signalReason(externalSignal, "Planning tick aborted");
    }
    const stream = await jarvis.network(prompt, networkOptions);
    for await (const chunk of stream) {
      const projected = boundedEvent(chunk);
      if (projected) {
        const eventIteration = projected.iteration;
        if (eventIteration !== undefined) {
          const completedPrimitives = eventIteration + 1;
          observedIterations = Math.max(observedIterations, completedPrimitives);
          if (completedPrimitives > copied.maxPrimitives) {
            capViolation ??= capError;
          }
        }
        if (!eventDeliveryFailed && onEvent) {
          try {
            await onEvent(projected);
          } catch (error) {
            eventDeliveryFailed = true;
            eventDeliveryError = error;
          }
        }
      }
    }

    const status = await stream.status;
    if (externalSignal?.aborted) {
      throw signalReason(externalSignal, "Planning tick aborted");
    }
    if (eventDeliveryFailed) {
      throw eventDeliveryError;
    }
    if (capViolation) {
      throw capViolation;
    }
    if (status !== "success") {
      throw new Error(`Supervisor planning network failed with status ${status}`);
    }
    if (closureReason === undefined || observedIterations < 1) {
      throw new Error("Supervisor planning network succeeded without a terminal planning decision");
    }

    return {
      kind: ledger.length > 0 ? "ready_to_commit" : "no_proposals",
      tickId: copied.tickId,
      missionId: copied.missionId,
      proposals: [...ledger],
      iterations: observedIterations,
      selectedAgents: [...selectedAgents],
      terminalReason: closureReason,
      networkStatus: "success",
    };
  } catch (error) {
    if (externalSignal?.aborted) {
      throw signalReason(externalSignal, "Planning tick aborted");
    }
    throw error;
  } finally {
    if (externalListenerAttached) {
      externalSignal?.removeEventListener("abort", forwardExternalAbort);
    }
  }
}
