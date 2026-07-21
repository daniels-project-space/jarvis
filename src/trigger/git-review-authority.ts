import { vaultService } from "../lib/vault-client";
import { createGitReviewReceiptAuthority } from "./git-review-receipt";

type Authority = ReturnType<typeof createGitReviewReceiptAuthority>;
type LoadOptions = {
  environment?: NodeJS.ProcessEnv;
  loadVault?: (service: string) => Promise<Record<string, string>>;
};

let cached: Promise<Authority> | null = null;

/**
 * The HMAC key belongs only to the Trigger controller.  Do not resolve this
 * at module load: a warm worker can start before its environment is attached,
 * while the controller vault remains the durable source of the named secret.
 */
export async function loadGitReviewReceiptAuthority(options: LoadOptions = {}): Promise<Authority | null> {
  const environment = options.environment ?? process.env;
  const fromEnvironment = environment.JARVIS_GIT_REVIEW_RECEIPT_SECRET;
  let secret = fromEnvironment;
  if (!secret) {
    try {
      const values = await (options.loadVault ?? vaultService)("jarvis");
      secret = values.JARVIS_GIT_REVIEW_RECEIPT_SECRET ?? values.GIT_REVIEW_RECEIPT_SECRET;
    } catch {
      return null;
    }
  }
  if (!secret || Buffer.byteLength(secret) < 32) return null;
  try { return createGitReviewReceiptAuthority(secret); } catch { return null; }
}

/**
 * Cache only a successful authority.  A vault outage is an availability
 * signal, not a permanent identity decision for a warm controller process.
 */
export async function trustedGitReviewReceiptAuthority(): Promise<Authority | null> {
  if (cached) return cached;
  const loaded = await loadGitReviewReceiptAuthority();
  if (!loaded) return null;
  cached = Promise.resolve(loaded);
  return loaded;
}

export function resetGitReviewReceiptAuthorityForTest() { cached = null; }

/** Secret-free release/readiness signal for the controller health surface. */
export async function gitReviewReceiptAuthorityHealth(options: LoadOptions = {}) {
  const authority = await loadGitReviewReceiptAuthority(options);
  return {
    ready: Boolean(authority),
    // Never reveal source, value, length, digest, or any vault metadata.
    reason: authority ? "ready" : "JARVIS_GIT_REVIEW_RECEIPT_SECRET is unavailable or too short",
  } as const;
}
