import { vaultService } from "../lib/vault-client";
import {
  createGitReviewReceiptAuthority,
  createGitReviewReceiptKeyring,
  type GitReviewBinding,
  type GitReviewEnvelope,
} from "./git-review-receipt";

type Authority = ReturnType<typeof createGitReviewReceiptAuthority>;
type LoadOptions = {
  environment?: NodeJS.ProcessEnv;
  loadVault?: (service: string) => Promise<Record<string, string>>;
};

let cached: Promise<Authority> | null = null;

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
      return createGitReviewReceiptKeyring(
        { keyId: value.current.keyId, secret: value.current.secret },
        value.previous.map((entry) => ({ keyId: String(entry.keyId), secret: String(entry.secret) })),
      );
    } catch {
      return null;
    }
  }
  const legacy = environment.JARVIS_GIT_REVIEW_RECEIPT_SECRET;
  return legacy ? createGitReviewReceiptAuthority(legacy) : null;
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
      return secret ? createGitReviewReceiptAuthority(secret) : null;
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
export async function trustedGitReviewReceiptAuthority(): Promise<Authority | null> {
  if (cached) return cached;
  const loaded = await loadGitReviewReceiptAuthority();
  if (!loaded) return null;
  cached = Promise.resolve(loaded);
  return loaded;
}

export function resetGitReviewReceiptAuthorityForTest() { cached = null; }

export function repositoryDeliveryReadiness(required: boolean, authority: Authority | null) {
  return required && !authority
    ? { ready: false as const, reason: "controller receipt signer unavailable" }
    : { ready: true as const };
}

/**
 * Verify with the warm keyring, then reload configuration at most once. This
 * closes the normal rotation window without turning arbitrary failures into a
 * vault polling loop. Unknown or retired ids remain rejected after reload.
 */
export async function verifyGitReviewReceiptEnvelope(
  envelope: GitReviewEnvelope,
  binding: GitReviewBinding,
  options: LoadOptions = {},
): Promise<boolean> {
  const first = options.environment || options.loadVault
    ? await loadGitReviewReceiptAuthority(options)
    : await trustedGitReviewReceiptAuthority();
  if (first?.verify(envelope, binding)) return true;
  const reloaded = await loadGitReviewReceiptAuthority(options);
  if (!options.environment && !options.loadVault && reloaded) cached = Promise.resolve(reloaded);
  return Boolean(reloaded?.verify(envelope, binding));
}

/** Secret-free release/readiness signal for the controller health surface. */
export async function gitReviewReceiptAuthorityHealth(options: LoadOptions = {}) {
  const authority = await loadGitReviewReceiptAuthority(options);
  return {
    ready: Boolean(authority),
    // Never reveal source, value, length, digest, or any vault metadata.
    reason: authority ? "ready" : "controller receipt signer unavailable",
  } as const;
}
