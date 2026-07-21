import { describe, expect, it } from "vitest";
import { goalWorkApprovalPolicy, workApprovalPolicy } from "../../convex/workPolicy";
import { plannerTask, routeGoal, validatorTask } from "../lib/goal-mode";
import { classifyWorkSafety, SAFE_SANDBOX_EXECUTION_RULES } from "../lib/work-safety";
import {
  CLOUD_SANDBOX_APPROVAL_TASK,
  INTEGRATION_FINAL_BARRIER_APPROVAL_TASK,
  WORKSPACE_ISOLATION_APPROVAL_TASK,
} from "./fixtures/work-policy-regressions";

const CHAT_LATENCY_JOB_REGRESSION = {
  id: "js73f7b1rnjfqap286193t0hcs8awpq3",
  repo: "/home/ubuntu/jarvis",
  task:
    "Root-cause and repair Jarvis foreground chat latency/cutout behavior without weakening intelligence or introducing a second voice/model/provider. Production evidence on Trigger 20260720.11: a healthy warm jarvis-chat-turn claimed two sequential synthetic same-thread turns in 491ms and 268ms, but first visible text arrived at 3746ms and 1701ms. The first response was \"Understood, sir.\" to \"Reply with exactly ONE.\"; the second was \"Barcelona.\" to \"Reply with exactly TWO.\", so also audit turn/event association and short-turn correctness. Inspect the actual Codex app-server protocol implementation",
} as const;

describe("server-side work approval policy", () => {
  it("keeps explicitly requested zero-effect sandbox validation autonomous", () => {
    expect(SAFE_SANDBOX_EXECUTION_RULES).toContain("already authorized");
    expect(SAFE_SANDBOX_EXECUTION_RULES).toContain("cannot pay or charge");
    expect(SAFE_SANDBOX_EXECUTION_RULES).toContain("never authorizes live-effect flags");
  });

  it("lets verified delivery run autonomously inside Daniel's repository", () => {
    expect(
      workApprovalPolicy({
        task: "Deploy the release to production",
        repo: "jarvis",
        approvalRequired: false,
      }),
    ).toMatchObject({ required: false, deliveryMode: "auto_merge" });
    expect(
      workApprovalPolicy({
        task: "Merge the verified fix and deploy it",
        repo: "daniels-project-space/jarvis",
      }),
    ).toMatchObject({ required: false, deliveryMode: "auto_merge" });
    expect(
      workApprovalPolicy({
        task: "Merge the verified fix and deploy it",
        repo: "https://github.com/daniels-project-space/jarvis.git",
      }),
    ).toMatchObject({ required: false, deliveryMode: "auto_merge" });
    expect(
      workApprovalPolicy({
        task: "Fix the parser and run its regression suite",
        repo: "jarvis",
        approvalRequired: true,
        risk: "consequential",
      }),
    ).toMatchObject({ required: false, deliveryMode: "auto_merge" });
  });

  it("gates messaging, money, booking and destructive actions", () => {
    for (const task of [
      "Reply to the tenant",
      "Send the rent arrears notice to the customer",
      "Post the findings publicly",
      "Publish the campaign content publicly",
      "Advertise the rental listing",
      "Publish the package to npm",
      "Publish the app in the store",
      "Transfer the supplier payment",
      "Trade the selected shares",
      "Book the selected hotel",
      "Change the credential",
      "Delete the production records",
      "Deploy the provider change to production",
    ]) {
      expect(workApprovalPolicy({ task }).required).toBe(true);
    }
    expect(workApprovalPolicy({ task: "Order the selected product from the supplier" }).required).toBe(true);
    expect(workApprovalPolicy({ task: "Please order a real test item now" }).required).toBe(true);
    expect(workApprovalPolicy({ task: "Place a real order with the supplier" }).required).toBe(true);
  });

  it("does not let readonly waive an explicit consequential action", () => {
    expect(
      workApprovalPolicy({
        task: "Send a reply to the tenant",
        readonly: true,
        approvalRequired: false,
      }).required,
    ).toBe(true);
    expect(
      workApprovalPolicy({
        task: "Research replacement options and purchase the best one",
        readonly: true,
      }).required,
    ).toBe(true);
  });

  it("does not grant autonomous writes outside Daniel's portfolio", () => {
    expect(
      workApprovalPolicy({
        task: "Fix the parser and merge it",
        repo: "someone-else/project",
      }),
    ).toMatchObject({
      required: true,
      deliveryMode: "manual",
    });
  });

  it("allows bounded read-only and isolated repository work", () => {
    expect(workApprovalPolicy({ task: "Audit why publishing can race", readonly: true }).required).toBe(false);
    expect(
      workApprovalPolicy({
        task: "Audit whether an untrusted worker can send replies. Do not send anything.",
        readonly: true,
      }).required,
    ).toBe(false);
    expect(
      workApprovalPolicy({
        task:
          "Audit the release boundary. Live policy evidence: a test job asked to send a tenant reply; Convex blocked it.",
        readonly: true,
      }).required,
    ).toBe(false);
    expect(workApprovalPolicy({ task: "Fix the parser and run tests", repo: "jarvis" })).toMatchObject({
      required: false,
      deliveryMode: "auto_merge",
    });
    expect(workApprovalPolicy({ task: "Research current orchestration patterns" }).required).toBe(false);
    expect(
      workApprovalPolicy({
        task:
          "Commit only working code, message starting 'self-improve:'. Work on the isolated branch; the controller owns verified delivery.",
        repo: "jarvis",
        risk: "high",
      }),
    ).toMatchObject({ required: false, deliveryMode: "auto_merge" });
    expect(
      workApprovalPolicy({
        task: "Wire the Shopify order/fulfillment pipeline and make its webhook idempotent",
        repo: "daniels-project-space/dropship-ai",
      }),
    ).toMatchObject({ required: false, deliveryMode: "auto_merge" });
  });

  it("does not classify persisted conversational engineering evidence as consequential", () => {
    expect(CHAT_LATENCY_JOB_REGRESSION.id).toBe("js73f7b1rnjfqap286193t0hcs8awpq3");
    expect(
      classifyWorkSafety(CHAT_LATENCY_JOB_REGRESSION.task, {
        repo: CHAT_LATENCY_JOB_REGRESSION.repo,
      }),
    ).toEqual({ approvalRequired: false, boundary: "internal" });
  });

  it("distinguishes nominal chat wording and coordinated prohibitions from outreach", () => {
    for (const task of [
      "Fix the reply latency regression in the foreground worker.",
      "Correlate the message event with its response turn.",
      "The observed response was \"Reply with exactly THREE.\" during the synthetic protocol test.",
      "Do not message the maintainer and publish the findings publicly.",
      "Never send customer replies and publish transcript excerpts.",
    ]) {
      expect(classifyWorkSafety(task, { repo: "jarvis" }).approvalRequired, task).toBe(false);
    }

    for (const task of [
      "Reply to the tenant.",
      "Message the maintainer.",
      "Message event details to the maintainer.",
      "Fix the reply parser and reply to the tenant.",
      "Do not message the maintainer, but publish the findings publicly.",
      "Evidence: \"send the tenant reply.\"",
      "Audit the broken \"reply transcript. Purchase the selected product.",
    ]) {
      expect(classifyWorkSafety(task, { repo: "jarvis" }).approvalRequired, task).toBe(true);
    }
  });

  it("treats a controller review prompt sent through standard input as local transport", () => {
    for (const task of [
      "Send the delivery-controller review prompt through standard input instead of argv.",
      "Use standard input to send the delivery-controller review prompt instead of using argv.",
      "Send the reviewer prompt through stdin using the Codex exec dash input contract, never a temporary file and never argv.",
    ]) {
      expect(classifyWorkSafety(task, { repo: "jarvis" })).toEqual({
        approvalRequired: false,
        boundary: "internal",
      });
      expect(workApprovalPolicy({ task, repo: "jarvis", risk: "high" })).toMatchObject({
        required: false,
        deliveryMode: "auto_merge",
      });
    }

    for (const outreach of [
      "Send the delivery-controller review prompt to the maintainer.",
      "Send the delivery-controller review prompt through stdin to the reviewer.",
      "Send the maintainer the delivery-controller review prompt through stdin.",
      "Send the delivery-controller review prompt through stdin to Alice.",
      "Send Alice the delivery-controller review prompt through stdin.",
      "Send the reviewer prompt through stdin to Alice.",
      "Send the reviewer prompt to the maintainer.",
    ]) {
      expect(workApprovalPolicy({ task: outreach, repo: "jarvis" }).required).toBe(true);
    }
  });

  it("treats post-index as a technical prefix without waiving public posting", () => {
    for (const task of [
      "Add a post-index filter to the repository scanner.",
      "Add a post-index-stage filter to the repository scanner.",
    ]) {
      expect(classifyWorkSafety(task, { repo: "jarvis" })).toEqual({
        approvalRequired: false,
        boundary: "internal",
      });
      expect(workApprovalPolicy({ task, repo: "jarvis", risk: "high" })).toMatchObject({
        required: false,
        deliveryMode: "auto_merge",
      });
    }
    expect(
      workApprovalPolicy({
        task: "Post the index-stage findings publicly.",
        repo: "jarvis",
      }).required,
    ).toBe(true);
  });

  it("keeps the full repository approval regressions autonomous in standalone and Goal Mode", () => {
    expect(WORKSPACE_ISOLATION_APPROVAL_TASK.split("\n")[10]).toContain("publish the reviewed Git worker ref");
    expect(INTEGRATION_FINAL_BARRIER_APPROVAL_TASK.split("\n")[8]).toBe(
      "The deterministic final integration ref already equals the prepared synthetic head, but integrateReviewedWorker immediately prepares/observes only update_ref. A prior stage_blob POST may have applied and then lost its durable observe callback. Jarvis therefore declares integrated and releases FIFO while a prepared cold effect remains unobserved. Fix the root state machine, not the external script.",
    );
    expect(CLOUD_SANDBOX_APPROVAL_TASK).toContain("email-verified");
    expect(CLOUD_SANDBOX_APPROVAL_TASK).toContain("auto-stop/archive/delete");
    expect(CLOUD_SANDBOX_APPROVAL_TASK).toContain("pay-as-you-go");
    expect(CLOUD_SANDBOX_APPROVAL_TASK).toContain("message-queue");
    expect(CLOUD_SANDBOX_APPROVAL_TASK).toContain("publish a reviewed ref for root review");

    for (const task of [
      WORKSPACE_ISOLATION_APPROVAL_TASK,
      INTEGRATION_FINAL_BARRIER_APPROVAL_TASK,
      CLOUD_SANDBOX_APPROVAL_TASK,
    ]) {
      const standalone = workApprovalPolicy({
        task,
        repo: "daniels-project-space/jarvis",
        risk: "consequential",
        approvalRequired: true,
      });
      const goalMode = goalWorkApprovalPolicy({
        task,
        repo: "daniels-project-space/jarvis",
        risk: "consequential",
        approvalRequired: true,
        goalStage: "building",
      });
      expect(standalone).toMatchObject({ required: false, deliveryMode: "auto_merge" });
      expect(goalMode).toEqual(standalone);
    }
  });

  it("allows only precise owned-repository Git-ref publication grammar", () => {
    for (const task of [
      "Only the trusted delivery controller may publish the reviewed Git worker ref after verification.",
      "Publish the reviewed worker ref through the controller repository delivery.",
      "The controller may `publish` the `reviewed Git worker ref` after verification.",
      "The controller may publish only on the verified Git integration ref.",
      "The controller can publish the Git branch after review.",
      "The controller can publish the Git ref after review.",
    ]) {
      expect(classifyWorkSafety(task, { repo: "daniels-project-space/jarvis" }), task).toEqual({
        approvalRequired: false,
        boundary: "software_delivery",
      });
    }

    expect(classifyWorkSafety(
      "Publish the reviewed Git worker ref.",
      { repo: "someone-else/jarvis" },
    ).approvalRequired).toBe(true);

    for (const task of [
      "Publish the findings from the reviewed Git worker ref publicly.",
      "Publish the package from the reviewed worker ref to npm.",
      "Publish the reviewed worker ref and post the findings publicly.",
      "The trusted controller may publish the reviewed worker ref and email the customer.",
      "Publish public content after reviewing the Git branch.",
      "Publish the reviewed Git worker ref to the public.",
      "Publish the reviewed Git worker ref externally.",
      "Publish the reviewed branch.",
    ]) {
      expect(workApprovalPolicy({ task, repo: "daniels-project-space/jarvis" }).required, task).toBe(true);
    }
  });

  it("recognizes uppercase POST only in unambiguous HTTP/provider noun grammar", () => {
    for (const task of [
      "Reconcile the already-applied stage_blob POST whose callback was lost.",
      "Reconcile the already-applied `stage_blob POST` whose callback was lost.",
      "Record the stage_tree POST response before recovery.",
      "Inspect the HTTP POST request idempotency key.",
      "Inspect the `HTTP POST request` idempotency key.",
      "Verify POST /webhook returns 204.",
      "Document `POST /webhook` in the API contract.",
      "Reconcile the response-lost POST before retrying the provider effect.",
      "Persist provider-method POST evidence with the effect receipt.",
      "A prior stage_blob POST may have applied and then lost its durable observe callback.",
      "A prior stage_blob POST might have failed before the callback.",
      "A prior stage_blob POST could have returned without a durable observation.",
      "A prior stage_blob POST can have applied before recovery.",
      "A prior stage_blob POST should have failed with a receipt.",
      "A prior stage_blob POST would have returned a provider result.",
      "A prior stage_blob POST will have applied by reconciliation.",
      "A prior stage_blob POST must have returned before observation.",
    ]) {
      expect(classifyWorkSafety(task), task).toEqual({ approvalRequired: false, boundary: "internal" });
    }

    for (const task of [
      "post the findings publicly",
      "Post the findings publicly",
      "POST the findings publicly",
      "Use stage_blob POST and post the result publicly.",
      "Inspect the HTTP POST request and post an advert.",
      "stage_blob POST the findings publicly.",
      "Post a social update about POST /webhook.",
    ]) {
      expect(workApprovalPolicy({ task, repo: "daniels-project-space/jarvis" }).required, task).toBe(true);
    }
  });

  it("recognizes only the precise cloud-sandbox compounds and controller Git-ref handoff", () => {
    for (const task of [
      "Keep access bound to the email-verified identity state.",
      "Represent auto-stop/archive/delete as sandbox lifecycle policy.",
      "Model pay-as-you-go billing configuration.",
      "Keep delivery behind the message-queue boundary.",
      "Only the trusted controller may publish a reviewed ref for root review.",
    ]) {
      expect(classifyWorkSafety(task, { repo: "daniels-project-space/jarvis" }).approvalRequired, task).toBe(false);
    }

    for (const task of [
      "Email the verified user.",
      "Delete the archived customer records.",
      "Pay the provider.",
      "Message the queue owner.",
      "Publish a reviewed report.",
      "Publish a reviewed ref for root review.",
      "Only the trusted controller may publish a reviewed ref for root review and email the customer.",
      "Deploy the provider change to production.",
      "Deploy the live provider configuration.",
      "Place a real customer order.",
      "Create a test supplier order.",
      "Advertise the rental listing.",
      "Trade the selected shares.",
      "Book the selected hotel.",
      "Rotate a secret.",
      "Keep the email-verified state and delete the customer records.",
      "Configure auto-stop/archive/delete customer records.",
      "Configure auto-stop/archive/delete archived customer data.",
      "Model pay-as-you-go billing and pay the provider.",
      "Inspect the message-queue and message the queue owner.",
      "Represent auto-stop/archive/delete, then publish the findings publicly.",
    ]) {
      expect(workApprovalPolicy({ task, repo: "daniels-project-space/jarvis" }).required, task).toBe(true);
    }

    expect(workApprovalPolicy({
      task: "Only the trusted controller may publish a reviewed ref for root review.",
      repo: "someone-else/jarvis",
    }).required).toBe(true);
  });

  it("keeps technical temporal prefixes and communication nouns internal", () => {
    for (const task of [
      "Final delivery must prove the exact post-merge commit is live on the production Vercel alias and on each impacted provider before marking the job done.",
      "Preserve and test the valuable fixes; associate captions and TTS with the exact request and parent message.",
      "Prove with deterministic tests that a message arriving during handoff is claimed without a cold gap.",
      "Measure the post-merge handoff latency and retain the parent reply.",
      "Verify that the reply waiting during handoff keeps its request association.",
    ]) {
      expect(classifyWorkSafety(task, { repo: "jarvis" })).toEqual({
        approvalRequired: false,
        boundary: "internal",
      });
      expect(workApprovalPolicy({ task, repo: "jarvis", risk: "high" })).toMatchObject({
        required: false,
        deliveryMode: "auto_merge",
      });
    }
  });

  it("does not let temporal prefixes or communication nouns waive real external actions", () => {
    for (const task of [
      "Post the merge findings publicly.",
      "Publish the post-merge report publicly.",
      "Message the parent about the caption and TTS.",
      "Reply to the parent message.",
      "Send the parent message to the customer.",
      "Message arriving passengers about the delay.",
      "A message arriving during handoff should be sent to the customer.",
      "Review the parent message and reply to the tenant.",
    ]) {
      expect(classifyWorkSafety(task, { repo: "jarvis" }).approvalRequired, task).toBe(true);
      expect(workApprovalPolicy({ task, repo: "jarvis" }).required, task).toBe(true);
    }
  });

  it("keeps mixed technical clauses gated and explicit prohibitions autonomous", () => {
    for (const mixed of [
      "Send the delivery-controller review prompt through stdin and message the maintainer.",
      "Add a post-index filter and post the index-stage findings publicly.",
      "Send the delivery-controller review prompt through stdin and pay the supplier.",
      "Add a post-index filter and rotate a key.",
      "Send the delivery-controller review prompt through stdin and delete production records.",
      "Add a post-index filter and publish the findings publicly.",
    ]) {
      expect(workApprovalPolicy({ task: mixed, repo: "jarvis" }).required).toBe(true);
    }
    expect(
      workApprovalPolicy({
        task: "Send the delivery-controller review prompt through stdin and deploy the live provider change.",
      }).required,
    ).toBe(true);
    expect(
      workApprovalPolicy({
        task: "Do not send the delivery-controller review prompt to the reviewer. Send the delivery-controller review prompt through stdin only.",
        repo: "jarvis",
      }),
    ).toMatchObject({ required: false, deliveryMode: "auto_merge" });
    expect(
      workApprovalPolicy({
        task: "Do not post the index-stage findings publicly. Add only the post-index filter.",
        repo: "jarvis",
      }),
    ).toMatchObject({ required: false, deliveryMode: "auto_merge" });
  });

  it("does not deadlock Goal Mode on its own generated planner safety contract", () => {
    const goal = "Produce a strictly read-only audit report with two evidence workstreams.";
    expect(workApprovalPolicy({
      task: plannerTask(goal, routeGoal(goal), ["Report concrete evidence"], 2),
      readonly: true,
      risk: "low",
    }).required).toBe(false);
  });

  it("keeps trusted Goal Mode review sessions moving when their quoted outcome is consequential", () => {
    const task =
      "GOAL MODE — SOL/MAX PLANNING SESSION. Plan only; do not act. Quoted outcome: delete production records and send customer replies after explicit approval.";

    // The general policy still fails closed for this text. Only Goal Mode's
    // internally-created, delivery-disabled review stages receive the bypass.
    expect(workApprovalPolicy({ task, repo: "daniels-project-space/dropship-ai", readonly: true }).required).toBe(true);
    expect(goalWorkApprovalPolicy({
      task,
      repo: "daniels-project-space/dropship-ai",
      readonly: true,
      goalStage: "planning",
    })).toMatchObject({ required: false, deliveryMode: "read_only" });
    expect(goalWorkApprovalPolicy({
      task,
      repo: "daniels-project-space/dropship-ai",
      readonly: true,
      goalStage: "validating",
    })).toMatchObject({ required: false, deliveryMode: "read_only" });
    expect(goalWorkApprovalPolicy({
      task,
      repo: "daniels-project-space/dropship-ai",
      readonly: true,
      goalStage: "building",
    }).required).toBe(true);
  });

  it("does not mistake a no-POST evidence boundary for a POST request", () => {
    const auditSnapshot = JSON.stringify({
      authority: "Convex server-side Goal Mode snapshot",
      capturedAt: 1_725_000_000_000,
      mission: { status: "needs_input", pausedPhase: "validating" },
      coordinator: { deploymentVersion: "20260719.6", fresh: true, wakeResult: "dispatched" },
    });
    const task = validatorTask({
      goal: "Produce a strictly read-only production audit.",
      plan: {
        summary: "Read-only audit",
        route: "general",
        assumptions: [],
        workstreams: [],
        validation: { criteria: [], tests: [], liveChecks: [] },
      },
      acceptanceCriteria: ["Keep every provider boundary read-only"],
      buildEvidence: [{
        label: "Production state",
        status: "done",
        result: "Production-state proof is incomplete under the no-POST boundary.",
      }],
      revisionWave: 0,
      auditSnapshot,
    });
    expect(task).toContain("Delivery-controller audit snapshot");
    expect(task).toContain(auditSnapshot);
    expect(task).toContain("unavailable inside the sandbox is not, by itself, a blocker");
    expect(workApprovalPolicy({ task, readonly: true, risk: "low" }).required).toBe(false);
  });

  it("does not let an evidence label disguise a fresh imperative", () => {
    expect(
      workApprovalPolicy({
        task: "Audit the release boundary. Evidence: send the tenant reply",
        readonly: true,
      }).required,
    ).toBe(true);
    expect(workApprovalPolicy({ task: "Commit the fix and message the tenant", repo: "jarvis" }).required).toBe(true);
    expect(workApprovalPolicy({ task: "Commit the fix, message the tenant", repo: "jarvis" }).required).toBe(true);
  });

  it("fails closed for an unclassified non-repository action", () => {
    expect(workApprovalPolicy({ task: "Handle this for me" })).toMatchObject({
      required: true,
      reason: "unclassified non-repository action defaults to approval",
    });
  });
});
