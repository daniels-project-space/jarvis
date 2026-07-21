import { vaultService } from "../lib/vault-client";
import {
  createGitReviewReceiptAuthority,
  createGitReviewReceiptKeyring,
  type GitReviewBinding,
  type GitReviewEnvelope,
} from "./git-review-receipt";

type ReceiptAuthority = ReturnType<typeof createGitReviewReceiptAuthority>;
type Authority = ReceiptAuthority & { configuration: "rotating" | "legacy" };
type LoadOptions = {
  environment?: NodeJS.ProcessEnv;
  loadVault?: (service: string) => Promise<Record<string, string>>;
};

// A warm copy is only a diagnostic/performance hint. It is never consulted as
// authority at an issuance or verification boundary because a key may have
// been retired while this Trigger worker remained warm.
let cached: Authority | null = null;

function configuredAuthority(environment: NodeJS.ProcessEnv): Authority | null {
  const serialized = environment.JARVIS_GIT_REVIEW_RECEIPT_KEYRING;
  if (serialized) {
    try {
      const value = JSON.parse(serialized) as {
        current?: { keyId?: unknown; secret?: unknown };
        previous?: Array<{ keyId?: unknown; secret?: unknown }>;
      };
      if (typeof value.current?.keyId !== "string" || typeof value.current.secret !== "string") return null;
      if (!Array.isArray(value.previous)) return null;
      if (value.previous.some((entry) => typeof entry?.keyId !== "string" || typeof entry?.secret !== "string")) return null;
      return Object.assign(createGitReviewReceiptKeyring(
        { keyId: value.current.keyId, secret: value.current.secret },
        value.previous.map((entry) => ({ keyId: String(entry.keyId), secret: String(entry.secret) })),
      ), { configuration: "rotating" as const });
    } catch {
      return null;
    }
  }
  const legacy = environment.JARVIS_GIT_REVIEW_RECEIPT_SECRET;
  return legacy ? Object.assign(createGitReviewReceiptAuthority(legacy), { configuration: "legacy" as const }) : null;
}

/**
 * The HMAC key belongs only to the Trigger controller.  Do not resolve this
 * at module load: a warm worker can start before its environment is attached,
 * while the controller vault remains the durable source of the named secret.
 */
export async function loadGitReviewReceiptAuthority(options: LoadOptions = {}): Promise<Authority | null> {
  const environment = options.environment ?? process.env;
  try {
    const direct = configuredAuthority(environment);
    if (direct) return direct;
  } catch { return null; }
  if (!environment.JARVIS_GIT_REVIEW_RECEIPT_KEYRING && !environment.JARVIS_GIT_REVIEW_RECEIPT_SECRET) {
    try {
      const values = await (options.loadVault ?? vaultService)("jarvis");
      const authority = configuredAuthority(values as NodeJS.ProcessEnv);
      if (authority) return authority;
      const secret = values.GIT_REVIEW_RECEIPT_SECRET;
      return secret ? Object.assign(createGitReviewReceiptAuthority(secret), { configuration: "legacy" as const }) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Cache only a successful authority.  A vault outage is an availability
 * signal, not a permanent identity decision for a warm controller process.
 */
export async function trustedGitReviewReceiptAuthority(options: LoadOptions = {}): Promise<Authority | null> {
  const loaded = await loadGitReviewReceiptAuthority(options);
  if (!loaded) {
    cached = null;
    return null;
  }
  cached = loaded;
  return loaded;
}

export function resetGitReviewReceiptAuthorityForTest() { cached = null; }

export function repositoryDeliveryReadiness(required: boolean, authority: Authority | null) {
  return required && authority?.configuration !== "rotating"
    ? { ready: false as const, reason: "rotating controller receipt signer unavailable" }
    : { ready: true as const };
}

/**
 * Read authoritative configuration at every verification boundary, then
 * reload at most once when a valid snapshot does not know the presented key.
 * This closes a normal rotation race without polling. A missing/invalid fresh
 * snapshot fails closed and can never fall back to a cached retired key.
 */
export async function verifyGitReviewReceiptEnvelope(
  envelope: GitReviewEnvelope,
  binding: GitReviewBinding,
  options: LoadOptions = {},
): Promise<boolean> {
  const first = await loadGitReviewReceiptAuthority(options);
  if (!first) {
    cached = null;
    return false;
  }
  cached = first;
  if (first?.verify(envelope, binding)) return true;
  const reloaded = await loadGitReviewReceiptAuthority(options);
  if (!reloaded) {
    cached = null;
    return false;
  }
  cached = reloaded;
  return Boolean(reloaded?.verify(envelope, binding));
}

/** Secret-free release/readiness signal for the controller health surface. */
export async function gitReviewReceiptAuthorityHealth(options: LoadOptions = {}) {
  const authority = await loadGitReviewReceiptAuthority(options);
  return {
    ready: authority?.configuration === "rotating",
    // Never reveal source, value, length, digest, or any vault metadata.
    reason: authority?.configuration === "rotating" ? "ready" : "rotating controller receipt signer unavailable",
  } as const;
}
