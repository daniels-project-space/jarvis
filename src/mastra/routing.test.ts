import { describe, expect, it } from "vitest";
import { routeWork, suggestedAcceptanceCriteria } from "./routing";
import {
  DROPSHIP_READ_ONLY_AUDIT_PROMPTS,
  PROHIBITION_FOLLOWED_BY_CONSEQUENTIAL_ACTION,
} from "./fixtures/read-only-prohibition-regressions";

describe("routeWork", () => {
  it("routes complex engineering to Paul at the deep tier", () => {
    const route = routeWork("Trace the root cause and redesign this multi-repo Convex architecture", { repo: "jarvis" });
    expect(route.agentId).toBe("paul");
    expect(route.model).toBe("sol");
    expect(route.approvalRequired).toBe(false);
    expect(suggestedAcceptanceCriteria("deploy it", route)).toContain(
      "Do not call it live until the production alias is verified",
    );
  });

  it("gates consequential external actions", () => {
    const route = routeWork("Send a reply to the customer and purchase the replacement");
    expect(route.approvalRequired).toBe(true);
    expect(route.risk).toBe("consequential");
    expect(route.readonly).toBe(true);
    expect(route.model).toBe("sol");
  });

  it("does not turn owned-repository merge and deploy work into a human decision", () => {
    const route = routeWork("Fix the worker, merge the verified PR, and deploy it", { repo: "jarvis" });
    expect(route).toMatchObject({
      agentId: "paul",
      approvalRequired: false,
      readonly: false,
    });
    expect(route.risk).not.toBe("consequential");
  });

  it("does not accept readonly as a consequential-risk override", () => {
    const route = routeWork("Send a reply to the customer", { readonly: true });
    expect(route.approvalRequired).toBe(true);
    expect(route.risk).toBe("consequential");
    expect(route.readonly).toBe(true);
  });

  it("keeps negated security-audit language read-only", () => {
    const route = routeWork(
      "Audit whether a worker can send replies. Do not send, publish, or deploy anything.",
      { readonly: true },
    );
    expect(route.approvalRequired).toBe(false);
    expect(route.readonly).toBe(true);
  });

  it("keeps long coordinated read-only audit prohibitions autonomous", () => {
    for (const task of DROPSHIP_READ_ONLY_AUDIT_PROMPTS) {
      const route = routeWork(task, {
        repo: "daniels-project-space/dropship-ai",
        readonly: true,
      });
      expect(route.approvalRequired, task).toBe(false);
      expect(route.readonly, task).toBe(true);
      expect(route.risk, task).not.toBe("consequential");
    }
  });

  it("does not let a long prohibition or readonly waive a later imperative", () => {
    for (const task of PROHIBITION_FOLLOWED_BY_CONSEQUENTIAL_ACTION) {
      const route = routeWork(task, {
        repo: "daniels-project-space/dropship-ai",
        readonly: true,
      });
      expect(route.approvalRequired, task).toBe(true);
      expect(route.risk, task).toBe("consequential");
    }
  });

  it("does not mistake reported audit evidence for a new action", () => {
    const route = routeWork(
      "Audit the release. Live policy evidence: a test job asked to send a tenant reply; Convex blocked it.",
      { readonly: true },
    );
    expect(route.approvalRequired).toBe(false);
    expect(route.readonly).toBe(true);
  });

  it("uses the permanent creative and travel specialists", () => {
    expect(routeWork("Illustrate a storyboard for the launch").agentId).toBe("iris");
    expect(routeWork("Plan a visual trip with flights and hotels").agentId).toBe("maya");
  });

  it("does not honour a cheap override for hard work", () => {
    expect(routeWork("Production security architecture migration", { requestedModel: "luna" }).model).toBe("sol");
  });
});
