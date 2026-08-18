import "server-only";
import { getVercelOidcToken } from "@vercel/oidc";
import { gmailSearch, gmailReadMessage } from "./gmail";
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

  // Preferred path: Vercel OIDC. The deployment already holds a short-lived,
  // Vercel-signed JWT proving it is this project; jarvis-browser verifies it
  // against Vercel's public JWKS. Nothing secret is stored, pasted or committed
  // to make this work — which is the whole reason it is first in the chain.
  const oidc = await getVercelOidcToken().catch(() => null);
  if (oidc) return { base, token: oidc };

  // Fallbacks for local dev and break-glass, in decreasing order of convenience.
  const token = process.env.JARVIS_BROWSER_TOKEN
    ?? await getSecret("jarvisbrowser", "JARVIS_BROWSER_TOKEN").catch(() => null);

  if (!token) {
    throw new BrowserServiceUnconfigured(
      "No Vercel OIDC token and no JARVIS_BROWSER_TOKEN. In production this means OIDC is off — "
      + "enable Settings → Security → Secure Backend Access with OIDC Federation on the jarvis "
      + "project (it is on by default). Locally, set JARVIS_BROWSER_TOKEN; the value is in "
      + "/etc/jarvis-browser/env on the browser host (sudo jarvis-browser-token).",
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

/**
 * Fetch a login code from Daniel's mailbox for an email-code site.
 *
 * Bounded deliberately: scoped to the credential's configured sender, to mail
 * newer than the login attempt, and returns ONLY a short code. It never returns
 * message bodies or links, so this cannot become a general inbox read, and an
 * emailed link cannot steer the browser off the approved hosts.
 */
async function fetchLoginCode(senderHint: string | null, since: number): Promise<string | null> {
  const sender = (senderHint ?? "").trim();
  if (!sender) return null;
  const afterSeconds = Math.floor(since / 1000) - 60;
  const messages = await gmailSearch(`from:${sender} after:${afterSeconds}`, 5).catch(() => []);
  for (const message of messages) {
    const detail = await gmailReadMessage(message.id).catch(() => null);
    if (!detail) continue;
    const haystack = `${detail.subject ?? ""} ${detail.snippet ?? ""} ${detail.bodyText ?? ""}`;
    // Prefer a code adjacent to code-ish wording; fall back to a lone 6-digit run.
    const labelled = haystack.match(/(?:code|passcode|pin|otp)\D{0,20}([A-Z0-9]{4,8})\b/i);
    if (labelled) return labelled[1];
    const bare = haystack.match(/\b(\d{6})\b/);
    if (bare) return bare[1];
  }
  return null;
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

  // Email-code sites: the site has mailed a code; collect it and finish signing in.
  if (opened.status === 202 && opened.body?.status === "awaiting_email_code") {
    const requestedAt = Date.now();
    let code: string | null = null;
    // Mail delivery is not instant; a few short waits beat one long one.
    for (const waitMs of [4000, 6000, 10_000]) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      code = await fetchLoginCode(opened.body.codeSenderHint ?? null, requestedAt);
      if (code) break;
    }
    if (!code) {
      return await finish({
        status: "failed",
        summary: "Requested a login code but none arrived in the mailbox within ~20s. Check the credential's sender hint.",
        sends: 0,
        transcript,
      });
    }
    const completed = await call(`/tasks/${taskId}/login-code`, { method: "POST", base, token, body: { code } });
    if (completed.body?.status !== "logged_in") {
      return await finish({
        status: "failed",
        summary: `Login code was rejected: ${completed.body?.detail ?? "unknown reason"}`,
        sends: 0,
        transcript,
      });
    }
    transcript.push("signed in (email code)");
  } else if (opened.status !== 201) {
    const reason = opened.body?.status === "needs_otp"
      ? "The site asked for a one-time code and none is stored. Add a TOTP secret with `jarvis-cred edit`, or log in once by hand."
      : opened.body?.reason ?? opened.body?.detail ?? `service returned ${opened.status}`;
    return await finish({ status: "failed", summary: `Could not start: ${reason}`, sends: 0, transcript });
  } else {
    transcript.push(`signed in (${opened.body.auth})`);
  }

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
