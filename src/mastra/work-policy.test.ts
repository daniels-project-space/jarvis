import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { goalWorkApprovalPolicy, workApprovalPolicy } from "../../convex/workPolicy";
import { plannerTask, routeGoal, validatorTask } from "../lib/goal-mode";
import { classifyWorkSafety, SAFE_SANDBOX_EXECUTION_RULES } from "../lib/work-safety";
import {
  INTEGRATION_FINAL_BARRIER_APPROVAL_TASK,
  WORKSPACE_ISOLATION_APPROVAL_TASK,
} from "./fixtures/work-policy-regressions";

const CLOUD_SANDBOX_APPROVAL_TASK = readFileSync(
  new URL("./fixtures/cloud-sandbox-approval-task.txt", import.meta.url),
  "utf8",
);
const CLOUD_SANDBOX_APPROVAL_TASK_SHA256 =
  "d48d26ff68ae0789b70fbc9520aefe45a3de204bfef79fef95fe3c4ef57f7130";

// Direct regression clauses recovered from the supplied Vercel technical
// lifecycle fixture.  They intentionally retain the classifier's former
// trigger words rather than replacing them with paraphrases.
const VERCEL_TECHNICAL_LIFECYCLE_REGRESSION = `
Replace regex/string-based Vercel absence detection. Test exact-name 404, wrong-name 404, generic 404 text, and non-404 failures for both get and delete.
Treat Sandbox.create as an ambiguous provider boundary. Generate and retain the random exact name before the call. If creation throws, perform a fresh Sandbox.get({ resume: false }) for that exact name: exact-name 404 proves no cleanup is needed; if it exists, exact-name delete it; if absence or deletion cannot be proved, throw cleanup_blocked. Test a create rejection after a fake remote create and malformed provider errors.
In prepareCloudWorkspaceExecution and replay, do not swallow cleanup failures after post-create lease loss, binding rejection, replay identity reuse, or replay binding rejection.
Keep the agent-runner terminal cleanup/reaper contract intact: a failed final delete remains un-terminated in Convex and is retried/reported by the orphan reaper.
Do not deploy, call a live Sandbox, mutate credentials/environment/billing/plan/budget, or add local/VPS execution fallback.
`;

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
    expect(Buffer.byteLength(CLOUD_SANDBOX_APPROVAL_TASK, "utf8")).toBe(7_876);
    expect(createHash("sha256").update(CLOUD_SANDBOX_APPROVAL_TASK).digest("hex")).toBe(
      CLOUD_SANDBOX_APPROVAL_TASK_SHA256,
    );
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

  it("enforces the exact cloud-sandbox acceptance matrix through every executable policy path", () => {
    const ownedRepo = "daniels-project-space/jarvis";
    const matrix = [
      { task: CLOUD_SANDBOX_APPROVAL_TASK, required: false },
      {
        task: "Represent auto-stop/archive/delete, snapshot identity, and persistent volumes as sandbox lifecycle configuration.",
        required: false,
      },
      { task: "Email the verified user.", required: true },
      { task: "Delete, snapshot, and export the archived customer records.", required: true },
      { task: "Configure auto-stop/archive/delete customer records.", required: true },
      { task: "Configure auto-stop/archive/delete archived customer data.", required: true },
      { task: "Pay the provider.", required: true },
      { task: "Message the queue owner.", required: true },
      { task: "Publish a reviewed report.", required: true },
      {
        task: "Only the trusted controller may publish a reviewed ref for root review and email the customer.",
        required: true,
      },
      {
        task: "Only the trusted controller may publish a reviewed ref for root review.",
        repo: "someone-else/jarvis",
        required: true,
      },
      {
        task: "Publish the public report, email the customer, pay the provider, delete production records, and deploy the live provider configuration.",
        required: true,
      },
    ] as const;

    for (const entry of matrix) {
      const repo = "repo" in entry ? entry.repo : ownedRepo;
      expect(classifyWorkSafety(entry.task, { repo }).approvalRequired, `classifier: ${entry.task}`).toBe(entry.required);
      expect(workApprovalPolicy({ task: entry.task, repo }).required, `standalone: ${entry.task}`).toBe(entry.required);
      for (const goalStage of ["building", "refining"] as const) {
        expect(
          goalWorkApprovalPolicy({ task: entry.task, repo, goalStage }).required,
          `${goalStage}: ${entry.task}`,
        ).toBe(entry.required);
      }
    }
  });

  it("keeps the Vercel simulated lifecycle regression autonomous through all producer policies", () => {
    const repo = "daniels-project-space/jarvis";
    expect(VERCEL_TECHNICAL_LIFECYCLE_REGRESSION).toContain("exact-name delete it");
    expect(VERCEL_TECHNICAL_LIFECYCLE_REGRESSION).toContain("post-create lease loss");
    expect(VERCEL_TECHNICAL_LIFECYCLE_REGRESSION).toContain("failed final delete remains");

    for (const clause of VERCEL_TECHNICAL_LIFECYCLE_REGRESSION.trim().split("\n")) {
      expect(classifyWorkSafety(clause, { repo }).approvalRequired, clause).toBe(false);
    }

    expect(classifyWorkSafety(VERCEL_TECHNICAL_LIFECYCLE_REGRESSION, { repo })).toEqual({
      approvalRequired: false,
      boundary: "internal",
    });
    expect(workApprovalPolicy({
      task: VERCEL_TECHNICAL_LIFECYCLE_REGRESSION,
      repo,
      risk: "consequential",
      approvalRequired: true,
    })).toMatchObject({ required: false, deliveryMode: "auto_merge" });
    for (const goalStage of ["building", "refining"] as const) {
      expect(goalWorkApprovalPolicy({
        task: VERCEL_TECHNICAL_LIFECYCLE_REGRESSION,
        repo,
        risk: "consequential",
        approvalRequired: true,
        goalStage,
      })).toMatchObject({ required: false, deliveryMode: "auto_merge" });
    }
  });

  it("does not let simulated lifecycle grammar waive real effects", () => {
    for (const task of [
      "Sandbox.get({ resume: false }) found the expected exact-name sandbox; exact-name delete the production records after a fake provider test.",
      "Sandbox.get({ resume: false }) found the expected exact-name sandbox; exact-name delete it from the live provider after a fake provider test.",
      "The failed final delete customer records remains un-terminated in Convex.",
      "Test get and delete customer records.",
      "Post the post-create incident report publicly.",
      "Deploy the live provider rollout after the post-create test.",
      "Send the cleanup result to the customer after the fake provider test.",
    ]) {
      expect(classifyWorkSafety(task, { repo: "daniels-project-space/jarvis" }).approvalRequired, task).toBe(true);
      expect(workApprovalPolicy({ task, repo: "daniels-project-space/jarvis" }).required, task).toBe(true);
    }
  });

  it("keeps neighboring cloud compounds narrow", () => {
    for (const task of [
      "Keep access bound to the email-verified identity state.",
      "Represent auto-stop/archive/delete as sandbox lifecycle policy.",
      "Contract-test bounded resources and TTL, auto-stop/archive/delete, snapshot identity, persistent volume isolation.",
      "Model pay-as-you-go billing configuration.",
      "Keep delivery behind the message-queue boundary.",
      "Only the trusted controller may publish a reviewed ref for root review.",
    ]) {
      expect(classifyWorkSafety(task, { repo: "daniels-project-space/jarvis" }).approvalRequired, task).toBe(false);
    }

    for (const task of [
      "Delete the archived customer records.",
      "Publish a reviewed ref for root review.",
      "Configure stop/archive/delete, snapshot identity for customer records.",
      "Configure auto-stop/archive/delete, customer snapshot identity.",
      "Configure auto-stop/archive/delete, snapshot customer identity.",
      "Configure auto-stop/archive/delete, snapshot identity for customer records.",
      "Configure auto-stop/archive/delete, snapshot identity customer records.",
      "Configure auto-stop/archive/delete, snapshot identity, then delete customer records.",
      "Model pay-as-you-go billing and pay the provider.",
      "Inspect the message-queue and message the queue owner.",
      "Represent auto-stop/archive/delete, then publish the findings publicly.",
    ]) {
      expect(workApprovalPolicy({ task, repo: "daniels-project-space/jarvis" }).required, task).toBe(true);
    }
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
