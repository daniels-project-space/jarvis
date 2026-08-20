import "server-only";
import { randomUUID } from "node:crypto";
import { getVercelOidcToken } from "@vercel/oidc";
import { gmailSearch, gmailReadMessage } from "./gmail";
import { convexMutation } from "./context";
import { getSecret } from "./vault";

// Client for the jarvis-browser service — the credentialed browser that acts
// as Daniel inside an owner-approved, foreground-receipted plan.
//
// This module never handles browser credentials. More importantly, it never
// accepts executable steps from its caller: Convex returns only the sealed
// snapshot copied into the approved record.

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

export type BrowserErrandRunAuthorization = Readonly<{
  foregroundReceiptKey: string;
}>;

const DEFAULT_BROWSER_URL = "https://87.106.233.113.nip.io/jarvis-browser";
const RECEIPT_KEY_RE = /^[A-Za-z0-9_.:-]{1,512}$/;
const MAX_UNTRUSTED_PAGE_TEXT_CHARS = 600;

class BrowserServiceUnconfigured extends Error {}
class BrowserDeadlineExceeded extends Error {}

async function serviceConfig(): Promise<{ base: string; token: string }> {
  const base = (process.env.JARVIS_BROWSER_URL
    ?? await getSecret("jarvisbrowser", "JARVIS_BROWSER_URL").catch(() => null)
    ?? DEFAULT_BROWSER_URL).replace(/\/+$/, "");

  // Preferred path: Vercel OIDC. The deployment holds a short-lived signed
  // JWT; no browser credential is copied into Vercel, Convex, or the model.
  const oidc = await getVercelOidcToken().catch(() => null);
  if (oidc) return { base, token: oidc };

  const token = process.env.JARVIS_BROWSER_TOKEN
    ?? await getSecret("jarvisbrowser", "JARVIS_BROWSER_TOKEN").catch(() => null);
  if (!token) {
    throw new BrowserServiceUnconfigured(
      "No Vercel OIDC token and no JARVIS_BROWSER_TOKEN are available for the browser service.",
    );
  }
  return { base, token };
}

function assertBeforeBrowserDeadline(deadlineAt?: number): void {
  if (deadlineAt !== undefined && (!Number.isSafeInteger(deadlineAt) || deadlineAt <= Date.now())) {
    throw new BrowserDeadlineExceeded();
  }
}

async function call(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown; token: string; base: string; deadlineAt?: number },
): Promise<{ status: number; body: Record<string, unknown> }> {
  assertBeforeBrowserDeadline(init.deadlineAt);
  const controller = new AbortController();
  let timedOut = false;
  const remainingMs = init.deadlineAt === undefined ? undefined : Math.max(1, init.deadlineAt - Date.now());
  const timeout = remainingMs === undefined
    ? undefined
    : setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, remainingMs);
  try {
    const response = await fetch(`${init.base}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${init.token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      cache: "no-store",
      signal: controller.signal,
    });
    const rawBody = await response.json().catch(() => ({}));
    return {
      status: response.status,
      body: rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
        ? rawBody as Record<string, unknown>
        : {},
    };
  } catch (error) {
    if (timedOut || error instanceof BrowserDeadlineExceeded || init.deadlineAt !== undefined && Date.now() >= init.deadlineAt) {
      throw new BrowserDeadlineExceeded();
    }
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function knownProviderStatus(value: unknown): "awaiting_email_code" | "needs_otp" | "logged_in" | null {
  return value === "awaiting_email_code" || value === "needs_otp" || value === "logged_in"
    ? value
    : null;
}

function safeUntrustedPageText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_UNTRUSTED_PAGE_TEXT_CHARS);
}

function boundedSends(value: unknown, current: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return Math.min(max, current + 1);
  return Math.min(max, Math.max(current, value));
}

function safeLoginCodeSenderHint(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sender = value.trim();
  return /^[^\s@<>]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,63}$/.test(sender) ? sender : null;
}

/**
 * Fetch a login code from Daniel's mailbox for an email-code site. The browser
 * provider may nominate only a bounded email sender; page/provider details
 * never flow into the model transcript or durable errand result.
 */
async function fetchLoginCode(senderHint: string | null, since: number): Promise<string | null> {
  const sender = senderHint ?? "";
  if (!sender) return null;
  const afterSeconds = Math.floor(since / 1000) - 60;
  const messages = await gmailSearch(`from:${sender} after:${afterSeconds}`, 5).catch(() => []);
  for (const message of messages) {
    const detail = await gmailReadMessage(message.id).catch(() => null);
    if (!detail) continue;
    const haystack = `${detail.subject ?? ""} ${detail.snippet ?? ""} ${detail.bodyText ?? ""}`;
    const labelled = haystack.match(/(?:code|passcode|pin|otp)\D{0,20}([A-Z0-9]{4,8})\b/i);
    if (labelled) return labelled[1];
    const bare = haystack.match(/\b(\d{6})\b/);
    if (bare) return bare[1];
  }
  return null;
}

async function waitWithinDeadline(waitMs: number, deadlineAt: number): Promise<void> {
  assertBeforeBrowserDeadline(deadlineAt);
  const remaining = deadlineAt - Date.now();
  if (remaining < waitMs) throw new BrowserDeadlineExceeded();
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  assertBeforeBrowserDeadline(deadlineAt);
}

export async function listBrowserCredentials(): Promise<Array<{ id: string; label: string; host: string }>> {
  const { base, token } = await serviceConfig();
  const { status, body } = await call("/credentials", { method: "GET", base, token });
  if (status !== 200 || !Array.isArray(body.credentials)) throw new Error(`browser service returned ${status}`);
  return body.credentials
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value))
    .flatMap((credential) => (
      typeof credential.id === "string" && typeof credential.label === "string" && typeof credential.host === "string"
        ? [{ id: credential.id.slice(0, 160), label: credential.label.slice(0, 240), host: credential.host.slice(0, 253) }]
        : []
    ));
}

/**
 * Run the exact owner-approved step snapshot. `foregroundReceiptKey` must be
 * a one-time live-turn receipt that chatQueue already bound to this errand.
 */
export async function runApprovedErrand(
  errandId: string,
  authorization: BrowserErrandRunAuthorization | undefined,
): Promise<ErrandOutcome> {
  if (!authorization || !RECEIPT_KEY_RE.test(authorization.foregroundReceiptKey)) {
    return {
      status: "failed",
      summary: "A one-time foreground owner execution receipt is required before a browser errand can run.",
      sends: 0,
      transcript: [],
    };
  }
  // Resolve configuration before claiming. A missing browser credential is an
  // availability problem, not a reason to consume Daniel's approved plan.
  let service: { base: string; token: string };
  try {
    service = await serviceConfig();
  } catch {
    return {
      status: "failed",
      summary: "Browser service is unavailable. This approval was left intact and nothing was started.",
      sends: 0,
      transcript: [],
    };
  }

  const leaseToken = randomUUID().replaceAll("-", "");
  let claim: any;
  try {
    claim = await convexMutation("browserErrands:claim", {
      errandId,
      leaseToken,
      foregroundReceiptKey: authorization.foregroundReceiptKey,
    });
  } catch {
    // The mutation may have committed just before its response was lost. A
    // matching final receipt can close only this exact lease; no browser task
    // has been issued and nothing is retried automatically.
    await convexMutation("browserErrands:finish", {
      errandId,
      leaseToken,
      status: "failed",
      result: "The execution claim was interrupted before browser work began. Nothing was retried automatically.",
      sends: 0,
    }).catch(() => undefined);
    return {
      status: "failed",
      summary: "Could not claim that errand. Nothing was retried automatically.",
      sends: 0,
      transcript: [],
    };
  }
  if (!claim?.ok) {
    return {
      status: "failed",
      summary: `Not runnable: ${typeof claim?.reason === "string" ? claim.reason.slice(0, 240) : "no approval on record"}. Propose the plan and let Daniel approve it first.`,
      sends: 0,
      transcript: [],
    };
  }

  const steps = Array.isArray(claim.steps) ? claim.steps as BrowserStep[] : [];
  const envelope = claim.envelope as BrowserEnvelope | undefined;
  const browserDeadlineAt = typeof claim.browserDeadlineAt === "number" && Number.isSafeInteger(claim.browserDeadlineAt)
    ? claim.browserDeadlineAt
    : 0;
  if (!steps.length || !envelope || browserDeadlineAt <= Date.now()) {
    await convexMutation("browserErrands:finish", {
      errandId,
      leaseToken,
      status: "failed",
      result: "The sealed browser plan was unavailable at execution time. Nothing was retried automatically.",
      sends: 0,
    }).catch(() => undefined);
    return {
      status: "failed",
      summary: "The sealed browser plan was unavailable at execution time. Nothing was retried automatically.",
      sends: 0,
      transcript: [],
    };
  }

  const { base, token } = service;
  const taskId = `errand-${String(errandId).replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 64);
  const transcript: string[] = [];
  let sends = 0;
  let taskMayExist = false;

  const finish = async (outcome: ErrandOutcome): Promise<ErrandOutcome> => {
    if (taskMayExist) {
      // Cleanup is safe and deliberately best-effort even after the browser
      // deadline. It never starts or advances a browser task.
      await call(`/tasks/${taskId}/close`, { method: "POST", base, token }).catch(() => undefined);
    }
    await convexMutation("browserErrands:finish", {
      errandId,
      leaseToken,
      status: outcome.status,
      result: outcome.summary,
      escalation: outcome.escalation,
      sends: outcome.sends,
    }).catch(() => undefined);
    return outcome;
  };

  try {
    taskMayExist = true;
    const opened = await call("/tasks", {
      method: "POST",
      base,
      token,
      deadlineAt: browserDeadlineAt,
      body: {
        taskId,
        envelope: {
          objective: claim.objective,
          credentialId: claim.credentialId ?? undefined,
          approvalRef: String(errandId),
          ...envelope,
          // The provider receives an absolute deadline as well as the
          // remaining normalized TTL. Vercel independently aborts every
          // request/step at this same deadline.
          deadlineAt: browserDeadlineAt,
        },
      },
    });

    const openedStatus = knownProviderStatus(opened.body.status);
    if (opened.status === 202 && openedStatus === "awaiting_email_code") {
      const requestedAt = Date.now();
      let code: string | null = null;
      const senderHint = safeLoginCodeSenderHint(opened.body.codeSenderHint);
      for (const waitMs of [4_000, 6_000, 10_000]) {
        await waitWithinDeadline(waitMs, browserDeadlineAt);
        code = await fetchLoginCode(senderHint, requestedAt);
        if (code) break;
      }
      if (!code) {
        return await finish({
          status: "failed",
          summary: "A login code was requested but could not be completed before the browser deadline. Nothing was retried automatically.",
          sends: 0,
          transcript,
        });
      }
      const completed = await call(`/tasks/${taskId}/login-code`, {
        method: "POST", base, token, deadlineAt: browserDeadlineAt, body: { code },
      });
      if (knownProviderStatus(completed.body.status) !== "logged_in") {
        return await finish({
          status: "failed",
          summary: "The browser could not confirm the login code. Nothing was retried automatically.",
          sends: 0,
          transcript,
        });
      }
      transcript.push("signed in (email code)");
    } else if (opened.status !== 201) {
      const summary = openedStatus === "needs_otp"
        ? "The site requires a one-time code that is not available to this browser errand. Complete the sign-in yourself."
        : `Could not start the browser task (service status ${opened.status}).`;
      return await finish({ status: "failed", summary, sends: 0, transcript });
    } else {
      transcript.push("browser task started");
    }

    for (const step of steps) {
      assertBeforeBrowserDeadline(browserDeadlineAt);
      const { status, body } = await call(`/tasks/${taskId}/step`, {
        method: "POST", base, token, deadlineAt: browserDeadlineAt, body: step,
      });
      if (status === 403) {
        return await finish({
          status: "blocked",
          summary: "Stopped — the browser host blocked a prohibited action. Do it yourself if needed.",
          sends,
          transcript,
        });
      }
      if (status === 409) {
        return await finish({
          status: "needs_step_approval",
          summary: "Paused — the browser host refused a step outside the sealed plan or policy boundary. Nothing further was done.",
          escalation: "The browser host refused a step outside the sealed plan or policy boundary.",
          sends,
          transcript,
        });
      }
      if (status !== 200) {
        return await finish({
          status: "failed",
          summary: `The sealed '${step.action}' step could not be completed (service status ${status}).`,
          sends,
          transcript,
        });
      }

      if (step.action === "send") sends = boundedSends(body.sends, sends, envelope.maxSends);
      if (step.action === "read") {
        const evidence = safeUntrustedPageText(body.untrustedPageText);
        transcript.push(evidence ? `read untrusted page evidence: ${evidence}` : "read page (no text returned)");
      } else {
        transcript.push(`${step.action}${step.label ? ` — ${step.label}` : ""}`);
      }
    }

    return await finish({
      status: "done",
      summary: `Completed "${String(claim.objective).slice(0, 500)}" in ${steps.length} sealed steps${sends ? `, ${sends} message(s) sent` : ""}.`,
      sends,
      transcript,
    });
  } catch (error) {
    // Provider `reason`/`detail` fields and thrown messages are deliberately
    // not reflected to the model or durable result. The status below is the
    // complete allowlisted external-error surface.
    const deadline = error instanceof BrowserDeadlineExceeded;
    return await finish({
      status: "failed",
      summary: deadline
        ? "The browser deadline elapsed before a final result arrived. Its outcome may be unknown, so it was not retried automatically."
        : "The browser errand stopped before a final result arrived. Its outcome may be unknown, so it was not retried automatically.",
      sends,
      transcript,
    });
  }
}

export async function readErrandAudit(errandId: string): Promise<unknown[]> {
  const { base, token } = await serviceConfig();
  const taskId = `errand-${String(errandId).replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 64);
  const { body } = await call(`/tasks/${taskId}/audit`, { method: "GET", base, token });
  // This helper has no current model caller. Preserve only bounded event kinds
  // for future owner audit UI rather than returning raw provider event details.
  return Array.isArray(body.events)
    ? body.events.slice(0, 100).flatMap((event) => {
      if (!event || typeof event !== "object" || Array.isArray(event)) return [];
      const kind = (event as Record<string, unknown>).kind;
      return typeof kind === "string" ? [{ kind: kind.slice(0, 80) }] : [];
    })
    : [];
}
