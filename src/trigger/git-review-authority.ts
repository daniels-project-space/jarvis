import { vaultService } from "../lib/vault-client";
import { createGitReviewReceiptAuthority } from "./git-review-receipt";

type Authority = ReturnType<typeof createGitReviewReceiptAuthority>;
type LoadOptions = {
  environment?: NodeJS.ProcessEnv;
  loadVault?: (service: string) => Promise<Record<string, string>>;
};

let cached: Promise<Authority | null> | null = null;

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

/** Cached only in the trusted controller process; never expose the key. */
export function trustedGitReviewReceiptAuthority(): Promise<Authority | null> {
  cached ??= loadGitReviewReceiptAuthority();
  return cached;
}

export function resetGitReviewReceiptAuthorityForTest() { cached = null; }
