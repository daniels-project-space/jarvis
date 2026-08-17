import "server-only";
import { convexMutation } from "./context";
import { getSecret } from "./vault";

// Client for the jarvis-browser service — the credentialed browser that acts as
// Daniel inside a plan he approved.
//
// Two properties this module must never lose:
//  1. It never handles a credential. `credentialId` is an opaque handle; the
//     sealed value lives root-only on the browser host and is typed straight
//     into a login form there. Nothing here can resolve it.
//  2. It never runs an unapproved plan. Execution begins by CLAIMING an
//     approved errand from Convex, which is single-use — so a repeated or
//     model-fabricated call cannot reuse one approval twice.

export type BrowserStep =
  | { action: "navigate"; url: string; label?: string }
  | { action: "read"; selector?: string; limit?: number; label?: string }
  | { action: "click"; selector: string; label?: string }
  | { action: "type"; selector: string; text: string; label?: string }
  | { action: "select"; selector: string; value: string; label?: string }
  | { action: "screenshot"; fullPage?: boolean; label?: string }
  | { action: "send"; selector: string; label?: string };

export type BrowserEnvelope = {
  allowedHosts: string[];
  allowedActions: string[];
  maxSends: number;
  maxSteps: number;
  ttlMs: number;
};

export type ErrandOutcome = {
  status: "done" | "failed" | "blocked" | "needs_step_approval";
  summary: string;
  sends: number;
  transcript: string[];
  escalation?: string;
};

// The service address is NOT a secret, so it does not need a vault row — it
// defaults to the deployed route and is overridable by env. Only the bearer is
// sensitive, and it resolves vault-first, env-fallback: the same shape
// render-service uses (RENDER_URL/RENDER_TOKEN work as Convex env vars rather
// than vault rows). That means bringing this online needs one pasted env var,
// not a vault write — which requires the root token and is owner-only by design.
const DEFAULT_BROWSER_URL = "https://87.106.233.113.nip.io/jarvis-browser";

class BrowserServiceUnconfigured extends Error {}

async function serviceConfig(): Promise<{ base: string; token: string }> {
  const base = (process.env.JARVIS_BROWSER_URL
    ?? await getSecret("jarvisbrowser", "JARVIS_BROWSER_URL").catch(() => null)
    ?? DEFAULT_BROWSER_URL).replace(/\/+$/, "");

  const token = process.env.JARVIS_BROWSER_TOKEN
    ?? await getSecret("jarvisbrowser", "JARVIS_BROWSER_TOKEN").catch(() => null);

  if (!token) {
    throw new BrowserServiceUnconfigured(
      "JARVIS_BROWSER_TOKEN is not set. Add it as an environment variable on the Jarvis "
      + "deployment (or as a jarvisbrowser vault row). The value is in /etc/jarvis-browser/env "
      + "on the browser host — read it with: sudo jarvis-browser-token",
    );
  }
  return { base, token };
}

async function call(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown; token: string; base: string },
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${init.base}${path}`, {
    method: init.method,
    headers: {
      authorization: `Bearer ${init.token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

export async function listBrowserCredentials(): Promise<Array<{ id: string; label: string; host: string }>> {
  const { base, token } = await serviceConfig();
  const { status, body } = await call("/credentials", { method: "GET", base, token });
  if (status !== 200) throw new Error(`browser service returned ${status}`);
  return body.credentials ?? [];
}

/**
 * Run a plan Daniel already approved. Claims the errand first; if it is not in
 * `approved` state this refuses rather than proceeding.
 */
export async function runApprovedErrand(errandId: string, steps: BrowserStep[]): Promise<ErrandOutcome> {
  const claim = await convexMutation("browserErrands:claim", { errandId });
  if (!claim?.ok) {
    return {
      status: "failed",
      summary: `Not runnable: ${claim?.reason ?? "no approval on record"}. Propose the plan and let Daniel approve it first.`,
      sends: 0,
      transcript: [],
    };
  }

  const { base, token } = await serviceConfig();
  const taskId = `errand-${String(errandId).replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 64);
  const transcript: string[] = [];
  let sends = 0;

  const finish = async (outcome: ErrandOutcome): Promise<ErrandOutcome> => {
    await call(`/tasks/${taskId}/close`, { method: "POST", base, token }).catch(() => undefined);
    await convexMutation("browserErrands:finish", {
      errandId,
      status: outcome.status,
      result: outcome.summary,
      escalation: outcome.escalation,
      sends: outcome.sends,
    });
    return outcome;
  };

  const opened = await call("/tasks", {
    method: "POST",
    base,
    token,
    body: {
      taskId,
      envelope: {
        objective: claim.objective,
        credentialId: claim.credentialId ?? undefined,
        approvalRef: String(errandId),
        ...claim.envelope,
      },
    },
  });

  if (opened.status !== 201) {
    const reason = opened.body?.status === "needs_otp"
      ? "The site asked for a one-time code and none is stored. Add a TOTP secret with `jarvis-cred edit`, or log in once by hand."
      : opened.body?.reason ?? opened.body?.detail ?? `service returned ${opened.status}`;
    return await finish({ status: "failed", summary: `Could not start: ${reason}`, sends: 0, transcript });
  }
  transcript.push(`signed in (${opened.body.auth})`);

  for (const step of steps) {
    const { status, body } = await call(`/tasks/${taskId}/step`, { method: "POST", base, token, body: step });

    if (status === 403) {
      return await finish({
        status: "blocked",
        summary: `Stopped — ${body.reason}. This class of action has no approval path; do it yourself.`,
        sends,
        transcript,
      });
    }
    if (status === 409) {
      return await finish({
        status: "needs_step_approval",
        summary: `Paused — ${body.reason}. Nothing further was done.`,
        escalation: body.reason,
        sends,
        transcript,
      });
    }
    if (status !== 200) {
      return await finish({
        status: "failed",
        summary: `Step '${step.action}' failed: ${body.reason ?? status}`,
        sends,
        transcript,
      });
    }

    if (step.action === "send") sends = body.sends ?? sends + 1;
    transcript.push(
      step.action === "read"
        ? `read ${body.url}: ${String(body.untrustedPageText ?? "").slice(0, 600)}`
        : `${step.action}${step.label ? ` — ${step.label}` : ""} → ${body.url ?? "ok"}`,
    );
  }

  return await finish({
    status: "done",
    summary: `Completed "${claim.objective}" in ${steps.length} steps${sends ? `, ${sends} message(s) sent` : ""}.`,
    sends,
    transcript,
  });
}

export async function readErrandAudit(errandId: string): Promise<unknown[]> {
  const { base, token } = await serviceConfig();
  const taskId = `errand-${String(errandId).replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 64);
  const { body } = await call(`/tasks/${taskId}/audit`, { method: "GET", base, token });
  return body.events ?? [];
}
