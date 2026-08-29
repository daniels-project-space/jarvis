import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2FunctionTool,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from "@ai-sdk/provider";
import { RequestContext } from "@mastra/core/request-context";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  SUPERVISOR_PLANNING_CONTEXT_MAX_BYTES,
  runSupervisorPlanningNetwork,
  type SupervisorNetworkEvent,
  type SupervisorPlanningTickInput,
} from "./mission-supervisor-network";

type SpecialistId = "paul" | "atlas" | "iris" | "maya" | "chloe" | "sentry";

type Proposal = {
  task: string;
  label: string;
  repo?: string;
  requestedModel?: "luna" | "terra" | "sol";
  readonly?: boolean;
  risk?: "low" | "medium" | "high" | "consequential";
  acceptanceCriteria: string[];
};

type RoutingDecision =
  | {
      primitiveId: SpecialistId;
      proposal: unknown;
      prompt?: string;
    }
  | {
      primitiveId: "none";
    };

type ScriptedResponse =
  | { kind: "text"; text: string; finishReason?: LanguageModelV2FinishReason }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      input: string;
    };

type RecordedCall = {
  kind: "routing" | "specialist-tool" | "specialist-final" | "network-final";
  options: LanguageModelV2CallOptions;
};

const usage: LanguageModelV2Usage = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
};

const validInput: SupervisorPlanningTickInput = {
  tickId: "tick-1",
  missionId: "mission-1",
  goal: "Plan a bounded and independently reviewable backend implementation slice.",
  profile: "short_fleet",
};

function responseSchemaContains(options: LanguageModelV2CallOptions, property: string): boolean {
  if (options.responseFormat?.type !== "json") {
    return false;
  }
  return JSON.stringify(options.responseFormat.schema).includes(`"${property}"`);
}

function functionTools(options: LanguageModelV2CallOptions): LanguageModelV2FunctionTool[] {
  return (options.tools ?? []).filter(
    (tool): tool is LanguageModelV2FunctionTool => tool.type === "function",
  );
}

function generatedContent(response: ScriptedResponse): {
  content: LanguageModelV2Content[];
  finishReason: LanguageModelV2FinishReason;
  usage: LanguageModelV2Usage;
  warnings: [];
} {
  if (response.kind === "tool") {
    return {
      content: [
        {
          type: "tool-call",
          toolCallId: response.toolCallId,
          toolName: response.toolName,
          input: response.input,
        },
      ],
      finishReason: "tool-calls",
      usage,
      warnings: [],
    };
  }
  return {
    content: [{ type: "text", text: response.text }],
    finishReason: response.finishReason ?? "stop",
    usage,
    warnings: [],
  };
}

function streamedContent(response: ScriptedResponse, responseId: string): LanguageModelV2StreamPart[] {
  const parts: LanguageModelV2StreamPart[] = [
    { type: "stream-start", warnings: [] },
    {
      type: "response-metadata",
      id: responseId,
      modelId: "scripted-supervisor",
      timestamp: new Date("2026-01-01T00:00:00.000Z"),
    },
  ];
  if (response.kind === "tool") {
    parts.push({
      type: "tool-call",
      toolCallId: response.toolCallId,
      toolName: response.toolName,
      input: response.input,
    });
  } else {
    const textId = `${responseId}-text`;
    parts.push({ type: "text-start", id: textId });
    parts.push({ type: "text-delta", id: textId, delta: response.text });
    parts.push({ type: "text-end", id: textId });
  }
  parts.push({
    type: "finish",
    finishReason:
      response.kind === "tool" ? "tool-calls" : (response.finishReason ?? "stop"),
    usage,
  });
  return parts;
}

function scriptedModel(
  decisions: RoutingDecision[],
  options: {
    invalidNetworkFinal?: boolean;
    blockFirstRouting?: boolean;
  } = {},
): {
  model: LanguageModelV2;
  calls: RecordedCall[];
  started: Promise<void>;
} {
  const remaining = [...decisions];
  const pendingProposals: unknown[] = [];
  const calls: RecordedCall[] = [];
  let sequence = 0;
  let started = false;
  let resolveStarted: (() => void) | undefined;
  const startedPromise = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });

  const waitForAbort = async (
    signal: AbortSignal | undefined,
  ): Promise<ScriptedResponse> => {
    if (!started) {
      started = true;
      resolveStarted?.();
    }
    const abortedResponse: ScriptedResponse = {
      kind: "text",
      text: JSON.stringify({
        primitiveId: "none",
        primitiveType: "none",
        prompt: "",
        selectionReason: "The scripted request was aborted.",
      }),
    };
    return new Promise<ScriptedResponse>((resolve) => {
      if (signal?.aborted) {
        resolve(abortedResponse);
        return;
      }
      signal?.addEventListener("abort", () => resolve(abortedResponse), { once: true });
    });
  };

  const next = async (call: LanguageModelV2CallOptions): Promise<ScriptedResponse> => {
    if (responseSchemaContains(call, "primitiveId")) {
      calls.push({ kind: "routing", options: call });
      if (options.blockFirstRouting) {
        return waitForAbort(call.abortSignal);
      }
      const decision = remaining.shift();
      if (!decision) {
        throw new Error("Scripted model ran out of routing decisions");
      }
      if (decision.primitiveId === "none") {
        return {
          kind: "text",
          text: JSON.stringify({
            primitiveId: "none",
            primitiveType: "none",
            prompt: "",
            selectionReason: "No additional independent proposal is available.",
          }),
        };
      }
      pendingProposals.push(decision.proposal);
      return {
        kind: "text",
        text: JSON.stringify({
          primitiveId: decision.primitiveId,
          primitiveType: "agent",
          prompt:
            decision.prompt ??
            "Propose one bounded, independently reviewable planning workstream.",
          selectionReason: `The ${decision.primitiveId} specialist owns this planning slice.`,
        }),
      };
    }

    if (responseSchemaContains(call, "finalResult")) {
      calls.push({ kind: "network-final", options: call });
      return {
        kind: "text",
        text: options.invalidNetworkFinal
          ? "not valid structured output"
          : JSON.stringify({ finalResult: "Planning proposals are ready for Daniel's review." }),
      };
    }

    const tools = functionTools(call);
    if (call.toolChoice?.type === "required") {
      calls.push({ kind: "specialist-tool", options: call });
      const proposal = pendingProposals.shift();
      const tool = tools.find((candidate) => candidate.name === "proposeWorkstream");
      if (proposal === undefined || !tool) {
        throw new Error("Scripted specialist did not receive its required proposal tool");
      }
      sequence += 1;
      return {
        kind: "tool",
        toolCallId: `proposal-${sequence}`,
        toolName: tool.name,
        input: JSON.stringify(proposal),
      };
    }

    calls.push({ kind: "specialist-final", options: call });
    return { kind: "text", text: "The bounded planning proposal was recorded." };
  };

  const model: LanguageModelV2 = {
    specificationVersion: "v2",
    provider: "scripted-test",
    modelId: "scripted-supervisor",
    supportedUrls: {},
    async doGenerate(call) {
      return generatedContent(await next(call));
    },
    async doStream(call) {
      sequence += 1;
      const responseId = `response-${sequence}`;
      const response = await next(call);
      return {
        stream: new ReadableStream<LanguageModelV2StreamPart>({
          start(controller) {
            for (const part of streamedContent(response, responseId)) {
              controller.enqueue(part);
            }
            controller.close();
          },
        }),
      };
    },
  };

  return { model, calls, started: startedPromise };
}

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    task: "Implement a bounded supervisor network with genuine runtime validation.",
    label: "Build supervisor",
    requestedModel: "terra",
    acceptanceCriteria: ["The focused real-runtime test passes."],
    ...overrides,
  };
}

describe("runSupervisorPlanningNetwork real Mastra runtime", () => {
  it(
    "routes through a specialist required tool call, validates, and finishes successfully",
    async () => {
      const harness = scriptedModel([{ primitiveId: "paul", proposal: proposal() }]);
      const events: SupervisorNetworkEvent[] = [];
      const tiers: string[] = [];

      const result = await runSupervisorPlanningNetwork(validInput, {
        modelFor: (tier) => {
          tiers.push(tier);
          return harness.model;
        },
        onEvent: (event) => {
          events.push(event);
        },
      });

      expect(result).toMatchObject({
        kind: "ready_to_commit",
        tickId: "tick-1",
        missionId: "mission-1",
        iterations: 1,
        selectedAgents: ["paul"],
        terminalReason: "desired_proposals_reached",
        networkStatus: "success",
      });
      expect(result.proposals).toHaveLength(1);
      expect(result.proposals[0]).toMatchObject({
        agentId: "paul",
        task: "Implement a bounded supervisor network with genuine runtime validation.",
        label: "Build supervisor",
      });
      expect(Object.hasOwn(result.proposals[0], "missionId")).toBe(false);
      expect(tiers).toEqual(["terra", "terra", "terra", "terra", "terra", "terra", "terra"]);
      expect(harness.calls.map((call) => call.kind)).toEqual([
        "routing",
        "specialist-tool",
        "specialist-final",
        "network-final",
      ]);

      const requiredToolCall = harness.calls.find(
        (call) => call.kind === "specialist-tool",
      );
      if (!requiredToolCall) {
        throw new Error("The specialist required-tool model call was not observed");
      }
      expect(requiredToolCall.options.toolChoice).toEqual({ type: "required" });
      expect(functionTools(requiredToolCall.options).map((tool) => tool.name)).toEqual([
        "proposeWorkstream",
      ]);
      const offeredTools = functionTools(requiredToolCall.options);
      const offeredProposalTool = offeredTools[0];
      if (!offeredProposalTool) {
        throw new Error("The proposal tool schema was not offered to the specialist");
      }
      const toolSchema = offeredProposalTool.inputSchema;
      expect(toolSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: ["task", "label", "acceptanceCriteria"],
        properties: {
          task: { minLength: 12, maxLength: 4000 },
          label: { minLength: 3, maxLength: 80 },
          requestedModel: { enum: ["luna", "terra", "sol"] },
          acceptanceCriteria: { minItems: 1, maxItems: 8 },
        },
      });

      const eventTypes = events.map((event) => event.type);
      expect(eventTypes).toEqual(
        expect.arrayContaining([
          "routing-agent-start",
          "routing-agent-end",
          "agent-execution-start",
          "agent-execution-event-tool-call",
          "agent-execution-event-tool-result",
          "agent-execution-end",
          "network-validation-start",
          "network-validation-end",
          "network-execution-event-finish",
        ]),
      );
      expect(events.every((event) => Object.keys(event).every(
        (key) => key === "type" || key === "primitiveId" || key === "iteration",
      ))).toBe(true);
      const routingCall = harness.calls.find((call) => call.kind === "routing");
      if (!routingCall) {
        throw new Error("The routing model call was not observed");
      }
      expect(functionTools(routingCall.options)).toEqual([]);
    },
    15_000,
  );

  it(
    "uses zero-based completion iterations and closes on the second accepted proposal",
    async () => {
      const harness = scriptedModel([
        {
          primitiveId: "paul",
          proposal: proposal({
            task: "Implement the first independent backend supervisor workstream.",
            label: "Backend slice",
          }),
        },
        {
          primitiveId: "iris",
          proposal: proposal({
            task: "Illustrate the independent live supervisor progress experience.",
            label: "Progress visual",
          }),
        },
      ]);
      const events: SupervisorNetworkEvent[] = [];

      const result = await runSupervisorPlanningNetwork(
        {
          ...validInput,
          tickId: "tick-two",
          missionId: "mission-two",
          profile: "durable_goal",
          desiredWorkstreams: 2,
          maxPrimitives: 2,
        },
        {
          modelFor: () => harness.model,
          onEvent: (event) => {
            events.push(event);
          },
        },
      );

      expect(result).toMatchObject({
        iterations: 2,
        terminalReason: "desired_proposals_reached",
        selectedAgents: ["paul", "iris"],
      });
      expect(result.proposals).toHaveLength(2);
      expect(harness.calls.map((call) => call.kind)).toEqual([
        "routing",
        "specialist-tool",
        "specialist-final",
        "routing",
        "specialist-tool",
        "specialist-final",
        "network-final",
      ]);
      expect(
        events
          .filter((event) => event.type === "network-validation-end")
          .map((event) => event.iteration),
      ).toEqual([0, 1]);
    },
    15_000,
  );

  it(
    "captures the routed owner and cannot weaken consequential safety policy",
    async () => {
      const harness = scriptedModel([
        {
          primitiveId: "atlas",
          proposal: proposal({
            task:
              "Implement and deploy the production rental reply service, then send the customer a confirmation.",
            label: "Rental confirmation",
            requestedModel: "luna",
            readonly: false,
            risk: "low",
          }),
        },
      ]);
      const capturedContexts: Array<Record<string, unknown>> = [];
      const originalToJSON = RequestContext.prototype.toJSON;
      const originalSet = RequestContext.prototype.set;
      const contextSpy = vi
        .spyOn(RequestContext.prototype, "set")
        .mockImplementation(function (
          this: RequestContext,
          key: string | number | symbol,
          value: unknown,
        ) {
          const beforeSet = originalToJSON.call(this);
          if (
            key === "MastraMemory" &&
            beforeSet.tickId === "tick-policy" &&
            !Object.hasOwn(beforeSet, "MastraMemory")
          ) {
            capturedContexts.push(beforeSet);
          }
          originalSet.call(this, key, value);
        });

      try {
        const result = await runSupervisorPlanningNetwork(
          {
            ...validInput,
            tickId: "tick-policy",
            missionId: "mission-policy",
            repo: "daniels-project-space/rental-manager-v2",
          },
          { modelFor: () => harness.model },
        );

        expect(result.proposals).toEqual([
          expect.objectContaining({
            agentId: "atlas",
            repo: "daniels-project-space/rental-manager-v2",
            model: "sol",
            readonly: true,
            approvalRequired: true,
            risk: "consequential",
          }),
        ]);
      } finally {
        contextSpy.mockRestore();
      }

      expect(capturedContexts.length).toBeGreaterThan(0);
      expect(capturedContexts).toEqual(
        capturedContexts.map(() => ({
          tickId: "tick-policy",
          missionId: "mission-policy",
          profile: "short_fleet",
        })),
      );
    },
    15_000,
  );

  it(
    "deduplicates equivalent owner/repo/task proposals and stops at the exact cap",
    async () => {
      const duplicate = proposal({
        task: "Investigate the same bounded database credit regression thoroughly.",
        label: "Credit regression",
        repo: "daniels-project-space/jarvis",
      });
      const harness = scriptedModel([
        { primitiveId: "sentry", proposal: duplicate },
        { primitiveId: "sentry", proposal: duplicate },
      ]);

      const result = await runSupervisorPlanningNetwork(
        {
          ...validInput,
          tickId: "tick-duplicate",
          missionId: "mission-duplicate",
          profile: "durable_goal",
          desiredWorkstreams: 2,
          maxPrimitives: 2,
        },
        { modelFor: () => harness.model },
      );

      expect(result).toMatchObject({
        kind: "ready_to_commit",
        iterations: 2,
        terminalReason: "primitive_cap_reached",
        selectedAgents: ["sentry"],
      });
      expect(result.proposals).toHaveLength(1);
      expect(harness.calls.filter((call) => call.kind === "specialist-tool")).toHaveLength(2);
      expect(harness.calls.filter((call) => call.kind === "routing")).toHaveLength(2);
    },
    15_000,
  );

  it(
    "returns no proposals when the router selects none at the cap",
    async () => {
      const harness = scriptedModel([{ primitiveId: "none" }]);

      const result = await runSupervisorPlanningNetwork(
        {
          ...validInput,
          tickId: "tick-none",
          missionId: "mission-none",
          maxPrimitives: 1,
        },
        { modelFor: () => harness.model },
      );

      expect(result).toEqual({
        kind: "no_proposals",
        tickId: "tick-none",
        missionId: "mission-none",
        proposals: [],
        iterations: 1,
        selectedAgents: [],
        terminalReason: "primitive_cap_reached",
        networkStatus: "success",
      });
      expect(harness.calls.map((call) => call.kind)).toEqual(["routing", "network-final"]);
    },
    15_000,
  );

  it(
    "rejects a desired count above the primitive cap without model work",
    async () => {
      let modelCalls = 0;
      await expect(
        runSupervisorPlanningNetwork(
          {
            ...validInput,
            tickId: "tick-over-cap",
            missionId: "mission-over-cap",
            profile: "durable_goal",
            desiredWorkstreams: 6,
            maxPrimitives: 1,
          },
          {
            modelFor: () => {
              modelCalls += 1;
              throw new Error("modelFor must not be called");
            },
          },
        ),
      ).rejects.toThrow("desiredWorkstreams cannot exceed maxPrimitives");
      expect(modelCalls).toBe(0);
    },
    15_000,
  );

  it(
    "rejects ownership and policy spoof fields through the real proposal tool schema",
    async () => {
      const spoofedProposal = {
        ...proposal(),
        agentId: "sentry",
        owner: "sentry",
        approvalRequired: true,
        model: "sol",
      };
      const harness = scriptedModel([
        { primitiveId: "paul", proposal: spoofedProposal },
      ]);

      const result = await runSupervisorPlanningNetwork(
        {
          ...validInput,
          tickId: "tick-spoof",
          missionId: "mission-spoof",
          maxPrimitives: 1,
        },
        { modelFor: () => harness.model },
      );

      expect(result).toMatchObject({
        kind: "no_proposals",
        proposals: [],
        selectedAgents: [],
        terminalReason: "primitive_cap_reached",
      });
      expect(harness.calls.filter((call) => call.kind === "specialist-tool")).toHaveLength(1);
    },
    15_000,
  );

  it(
    "creates fresh model-backed agents and planning state for every invocation",
    async () => {
      const first = scriptedModel([
        {
          primitiveId: "paul",
          proposal: proposal({
            task: "Implement the first invocation without leaking its planning state.",
            label: "First invocation",
          }),
        },
      ]);
      const second = scriptedModel([
        {
          primitiveId: "maya",
          proposal: proposal({
            task: "Plan the second invocation travel workflow without prior state.",
            label: "Second invocation",
          }),
        },
      ]);
      const firstTiers: string[] = [];
      const secondTiers: string[] = [];

      const firstResult = await runSupervisorPlanningNetwork(
        { ...validInput, tickId: "tick-fresh-1", missionId: "mission-fresh-1" },
        {
          modelFor: (tier) => {
            firstTiers.push(tier);
            return first.model;
          },
        },
      );
      const secondResult = await runSupervisorPlanningNetwork(
        { ...validInput, tickId: "tick-fresh-2", missionId: "mission-fresh-2" },
        {
          modelFor: (tier) => {
            secondTiers.push(tier);
            return second.model;
          },
        },
      );

      expect(firstTiers).toHaveLength(7);
      expect(secondTiers).toHaveLength(7);
      expect(firstResult.proposals.map((item) => item.label)).toEqual(["First invocation"]);
      expect(secondResult.proposals.map((item) => item.label)).toEqual(["Second invocation"]);
      expect(secondResult.selectedAgents).toEqual(["maya"]);
    },
    15_000,
  );

  it(
    "rejects a failed final structured response instead of treating stream completion as success",
    async () => {
      const harness = scriptedModel(
        [{ primitiveId: "paul", proposal: proposal() }],
        { invalidNetworkFinal: true },
      );

      await expect(
        runSupervisorPlanningNetwork(
          { ...validInput, tickId: "tick-failed", missionId: "mission-failed" },
          { modelFor: () => harness.model },
        ),
      ).rejects.toThrow("Supervisor planning network failed with status failed");
      expect(harness.calls.some((call) => call.kind === "network-final")).toBe(true);
    },
    15_000,
  );

  it(
    "drains the real network before rethrowing the first event callback error exactly",
    async () => {
      const harness = scriptedModel([
        { primitiveId: "paul", proposal: proposal() },
      ]);
      const reason = new Error("live event sink failed");
      let eventCalls = 0;

      await expect(
        runSupervisorPlanningNetwork(
          {
            ...validInput,
            tickId: "tick-event-error",
            missionId: "mission-event-error",
          },
          {
            modelFor: () => harness.model,
            onEvent: async () => {
              eventCalls += 1;
              await Promise.resolve();
              throw reason;
            },
          },
        ),
      ).rejects.toBe(reason);

      expect(eventCalls).toBe(1);
      expect(harness.calls.map((call) => call.kind)).toEqual([
        "routing",
        "specialist-tool",
        "specialist-final",
        "network-final",
      ]);
    },
    15_000,
  );

  it(
    "forwards the exact external abort reason and removes its listener",
    async () => {
      const harness = scriptedModel(
        [{ primitiveId: "none" }],
        { blockFirstRouting: true },
      );
      const controller = new AbortController();
      const addSpy = vi.spyOn(controller.signal, "addEventListener");
      const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
      const reason = new Error("stop this planning tick");

      try {
        const pending = runSupervisorPlanningNetwork(
          { ...validInput, tickId: "tick-abort", missionId: "mission-abort" },
          {
            modelFor: () => harness.model,
            abortSignal: controller.signal,
          },
        );
        await harness.started;
        controller.abort(reason);

        await expect(pending).rejects.toBe(reason);
        expect(addSpy).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
        expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
      } finally {
        addSpy.mockRestore();
        removeSpy.mockRestore();
      }
    },
    15_000,
  );
});

describe("runSupervisorPlanningNetwork strict input boundary", () => {
  async function expectRejectedBeforeModel(
    input: unknown,
    message: string,
  ): Promise<void> {
    let modelCalls = 0;
    await expect(
      runSupervisorPlanningNetwork(input as SupervisorPlanningTickInput, {
        modelFor: () => {
          modelCalls += 1;
          throw new Error("modelFor must not be called");
        },
      }),
    ).rejects.toThrow(message);
    expect(modelCalls).toBe(0);
  }

  it("rejects unknown string and symbol keys before model selection", async () => {
    await expectRejectedBeforeModel(
      { ...validInput, unexpected: "no" },
      "unknown property",
    );

    const symbolInput = { ...validInput };
    Object.defineProperty(symbolInput, Symbol("unexpected"), {
      value: true,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    await expectRejectedBeforeModel(symbolInput, "unknown property");
  });

  it("rejects accessors without invoking the getter", async () => {
    let getterCalls = 0;
    const accessorInput = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of Object.entries(validInput)) {
      Object.defineProperty(accessorInput, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    Object.defineProperty(accessorInput, "goal", {
      get() {
        getterCalls += 1;
        return validInput.goal;
      },
      enumerable: true,
      configurable: true,
    });

    await expectRejectedBeforeModel(accessorInput, "accessor");
    expect(getterCalls).toBe(0);
  });

  it("rejects proxies before invoking any reflection trap", async () => {
    let trapCalls = 0;
    const proxyInput = new Proxy(validInput, {
      getPrototypeOf() {
        trapCalls += 1;
        return Object.prototype;
      },
      ownKeys() {
        trapCalls += 1;
        return [];
      },
      getOwnPropertyDescriptor() {
        trapCalls += 1;
        return undefined;
      },
    });

    await expectRejectedBeforeModel(proxyInput, "proxy");
    expect(trapCalls).toBe(0);
  });

  it("rejects class instances and nonordinary data descriptors", async () => {
    class PlanningEnvelope {
      tickId = validInput.tickId;
      missionId = validInput.missionId;
      goal = validInput.goal;
      profile = validInput.profile;
    }
    await expectRejectedBeforeModel(new PlanningEnvelope(), "ordinary object");

    const fixedInput = { ...validInput };
    Object.defineProperty(fixedInput, "goal", {
      value: validInput.goal,
      enumerable: true,
      configurable: false,
      writable: true,
    });
    await expectRejectedBeforeModel(fixedInput, "ordinary data properties");
  });

  it("enforces the durable desired minimum before model selection", async () => {
    await expectRejectedBeforeModel(
      {
        ...validInput,
        profile: "durable_goal",
        desiredWorkstreams: 1,
      },
      "desiredWorkstreams is invalid",
    );
  });

  it("rejects rather than silently reducing desired workstreams below the primitive cap", async () => {
    await expectRejectedBeforeModel(
      {
        ...validInput,
        desiredWorkstreams: 2,
        maxPrimitives: 1,
      },
      "desiredWorkstreams cannot exceed maxPrimitives",
    );
  });

  it("accepts the exact UTF-8 context boundary and rejects one extra multibyte character", async () => {
    const exactContext = "é".repeat(
      SUPERVISOR_PLANNING_CONTEXT_MAX_BYTES / 2,
    );
    const controller = new AbortController();
    const reason = new Error("accepted exact byte boundary");
    controller.abort(reason);
    let modelCalls = 0;

    await expect(
      runSupervisorPlanningNetwork(
        { ...validInput, context: exactContext },
        {
          modelFor: () => {
            modelCalls += 1;
            throw new Error("modelFor must not be called");
          },
          abortSignal: controller.signal,
        },
      ),
    ).rejects.toBe(reason);
    expect(modelCalls).toBe(0);

    await expectRejectedBeforeModel(
      { ...validInput, context: `${exactContext}é` },
      "context is invalid",
    );
  });

  it("throws an already-aborted signal's exact reason before model selection", async () => {
    const controller = new AbortController();
    const reason = new Error("already stopped");
    controller.abort(reason);
    let modelCalls = 0;

    await expect(
      runSupervisorPlanningNetwork(validInput, {
        modelFor: () => {
          modelCalls += 1;
          throw new Error("modelFor must not be called");
        },
        abortSignal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(modelCalls).toBe(0);
  });
});
