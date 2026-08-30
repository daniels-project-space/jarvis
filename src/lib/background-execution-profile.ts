import { parseWorkModelTier, type WorkModelTier } from "./work-models";
import {
  canonicalNovitaPatchProposerAttestation,
  resolveNovitaPatchProposerAttestation,
  type NovitaPatchProposerAttestation,
} from "./novita-patch-proposer-attestation";

/**
 * The only model transport admitted to the current background executor.
 *
 * This deliberately describes the subscription transport, not a model tier:
 * Luna, Terra, and Sol remain quality selections within Codex rather than
 * becoming independently trusted execution providers.
 */
export const BACKGROUND_EXECUTION_PROVIDER = "codex-subscription" as const;
export const BACKGROUND_EXECUTION_PROFILE_VERSION = 1 as const;
export const BACKGROUND_DELEGATED_EXECUTION_PROFILE_VERSION = 2 as const;

export const BACKGROUND_REPOSITORY_CAPABILITIES = Object.freeze([
  "repository_exec",
  "repository_validate",
  "repository_read_file",
  "repository_list_files",
  "repository_write_file",
] as const);

const BACKGROUND_READ_REPOSITORY_CAPABILITIES = Object.freeze([
  "repository_validate",
  "repository_read_file",
  "repository_list_files",
] as const satisfies readonly BackgroundRepositoryCapability[]);

export type BackgroundExecutionProvider = typeof BACKGROUND_EXECUTION_PROVIDER;
export type BackgroundRepositoryCapability = (typeof BACKGROUND_REPOSITORY_CAPABILITIES)[number];

export type BackgroundExecutionAuthority = Readonly<{
  external: false;
  apps: false;
  secrets: false;
  network: false;
}>;

/**
 * A complete, serializable execution admission. Its authority shape is
 * derived by this module and cannot be widened by a caller-provided profile.
 */
type CodexBackgroundExecutionProfile = Readonly<{
  version: typeof BACKGROUND_EXECUTION_PROFILE_VERSION;
  provider: BackgroundExecutionProvider;
  modelTier: WorkModelTier;
  readonly: boolean;
  authority: BackgroundExecutionAuthority;
  repositoryCapabilities: readonly BackgroundRepositoryCapability[];
}>;

/**
 * Codex remains the sole workspace executor. Version 2 adds a bounded,
 * no-tool Novita draft stage whose non-secret identity is SHA-bound beside the
 * Codex authority; it cannot become an arbitrary provider switch.
 */
type DelegatedCodexBackgroundExecutionProfile = Readonly<{
  version: typeof BACKGROUND_DELEGATED_EXECUTION_PROFILE_VERSION;
  provider: BackgroundExecutionProvider;
  modelTier: WorkModelTier;
  readonly: boolean;
  authority: BackgroundExecutionAuthority;
  repositoryCapabilities: readonly BackgroundRepositoryCapability[];
  novitaPatchProposer: NovitaPatchProposerAttestation;
}>;

export type BackgroundExecutionProfile =
  | CodexBackgroundExecutionProfile
  | DelegatedCodexBackgroundExecutionProfile;

export type BackgroundExecutionProfileRejectionCode =
  | "invalid_profile"
  | "unsupported_provider"
  | "forbidden_authority"
  | "invalid_model_tier"
  | "invalid_repository_capability";

export type BackgroundExecutionProfileResolution =
  | Readonly<{ accepted: true; profile: BackgroundExecutionProfile }>
  | Readonly<{
    accepted: false;
    code: BackgroundExecutionProfileRejectionCode;
    reason: string;
  }>;

type ProfileInput = Readonly<Record<string, unknown>>;

const PROFILE_KEYS = new Set([
  "version",
  "provider",
  "modelTier",
  "readonly",
  "authority",
  "repositoryCapabilities",
]);
const DELEGATED_PROFILE_KEYS = new Set([...PROFILE_KEYS, "novitaPatchProposer"]);

const AUTHORITY_KEYS = new Set(["external", "apps", "secrets", "network"]);

const DENIED_AUTHORITY: BackgroundExecutionAuthority = Object.freeze({
  external: false,
  apps: false,
  secrets: false,
  network: false,
});

function isRecord(value: unknown): value is ProfileInput {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejected(
  code: BackgroundExecutionProfileRejectionCode,
  reason: string,
): BackgroundExecutionProfileResolution {
  return Object.freeze({ accepted: false as const, code, reason });
}

function profileProvider(value: unknown): BackgroundExecutionProvider | null {
  const provider = String(value ?? BACKGROUND_EXECUTION_PROVIDER).trim().toLowerCase();
  // `codex` is the runner's current local provider name; persist the
  // subscription-specific spelling so it cannot be confused with an arbitrary
  // executable named "codex".
  if (provider === "codex" || provider === BACKGROUND_EXECUTION_PROVIDER) {
    return BACKGROUND_EXECUTION_PROVIDER;
  }
  return null;
}

function validatesDeniedAuthority(value: unknown): BackgroundExecutionProfileRejectionCode | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return "invalid_profile";
  for (const [key, authority] of Object.entries(value)) {
    if (!AUTHORITY_KEYS.has(key)) return "invalid_profile";
    if (typeof authority !== "boolean") return "invalid_profile";
    if (authority) return "forbidden_authority";
  }
  return null;
}

function repositoryCapabilities(
  value: unknown,
  readonly: boolean,
): readonly BackgroundRepositoryCapability[] | BackgroundExecutionProfileRejectionCode {
  const allowed = readonly
    ? BACKGROUND_READ_REPOSITORY_CAPABILITIES
    : BACKGROUND_REPOSITORY_CAPABILITIES;
  const requested = value === undefined ? [...allowed] : value;
  if (!Array.isArray(requested)) return "invalid_repository_capability";

  const capabilities: BackgroundRepositoryCapability[] = [];
  for (const capability of requested) {
    if (typeof capability !== "string"
      || !(BACKGROUND_REPOSITORY_CAPABILITIES as readonly string[]).includes(capability)
      || !(allowed as readonly string[]).includes(capability)
      || capabilities.includes(capability as BackgroundRepositoryCapability)) {
      return "invalid_repository_capability";
    }
    capabilities.push(capability as BackgroundRepositoryCapability);
  }
  return Object.freeze(capabilities);
}

/**
 * Validates untrusted persisted/request data and derives the one currently
 * admitted background profile. It has no environment, vault, provider, or
 * network dependency: a missing or future provider must be explicitly added
 * to this allowlist before it can ever reach an executor.
 */
export function resolveBackgroundExecutionProfile(
  value: unknown = {},
): BackgroundExecutionProfileResolution {
  if (!isRecord(value)) return rejected("invalid_profile", "Background execution profile must be an object");
  const version = value.version === undefined ? BACKGROUND_EXECUTION_PROFILE_VERSION : value.version;
  if (version !== BACKGROUND_EXECUTION_PROFILE_VERSION && version !== BACKGROUND_DELEGATED_EXECUTION_PROFILE_VERSION) {
    return rejected("invalid_profile", "Background execution profile version is unsupported");
  }
  const keys = version === BACKGROUND_DELEGATED_EXECUTION_PROFILE_VERSION ? DELEGATED_PROFILE_KEYS : PROFILE_KEYS;
  if (Object.keys(value).some((key) => !keys.has(key))) {
    return rejected("invalid_profile", "Background execution profile contains an untrusted field");
  }

  const provider = profileProvider(value.provider);
  if (!provider) {
    return rejected(
      "unsupported_provider",
      "Only the current Codex subscription transport is admitted for background execution",
    );
  }

  const authorityError = validatesDeniedAuthority(value.authority);
  if (authorityError) {
    return rejected(
      authorityError,
      authorityError === "forbidden_authority"
        ? "Background execution denies external, app, secret, and network authority"
        : "Background execution authority must be a false-only allowlist",
    );
  }

  if (value.readonly !== undefined && typeof value.readonly !== "boolean") {
    return rejected("invalid_profile", "Background execution readonly must be boolean");
  }
  const readonly = value.readonly !== false;
  const modelTier = value.modelTier === undefined ? "terra" : parseWorkModelTier(value.modelTier);
  if (!modelTier) {
    return rejected("invalid_model_tier", "Background execution requires a known Codex model tier");
  }

  const capabilities = repositoryCapabilities(value.repositoryCapabilities, readonly);
  if (typeof capabilities === "string") {
    return rejected(
      capabilities,
      "Background execution repository capabilities exceed the admitted Codex scope",
    );
  }

  const novitaPatchProposer = version === BACKGROUND_DELEGATED_EXECUTION_PROFILE_VERSION
    ? resolveNovitaPatchProposerAttestation(value.novitaPatchProposer)
    : undefined;
  if (version === BACKGROUND_DELEGATED_EXECUTION_PROFILE_VERSION && !novitaPatchProposer) {
    return rejected("invalid_profile", "Novita patch-proposer attestation is invalid");
  }
  if (version === BACKGROUND_DELEGATED_EXECUTION_PROFILE_VERSION && modelTier !== "terra") {
    return rejected("invalid_model_tier", "Novita patch drafts require a Terra Codex reviewer");
  }

  if (version === BACKGROUND_DELEGATED_EXECUTION_PROFILE_VERSION && novitaPatchProposer) {
    return Object.freeze({
      accepted: true as const,
      profile: Object.freeze({
        version: BACKGROUND_DELEGATED_EXECUTION_PROFILE_VERSION,
        provider,
        modelTier,
        readonly,
        authority: DENIED_AUTHORITY,
        repositoryCapabilities: capabilities,
        novitaPatchProposer,
      }),
    });
  }

  return Object.freeze({
    accepted: true as const,
    profile: Object.freeze({
      version: BACKGROUND_EXECUTION_PROFILE_VERSION,
      provider,
      modelTier,
      readonly,
      authority: DENIED_AUTHORITY,
      repositoryCapabilities: capabilities,
    }),
  });
}

/**
 * Non-throwing derivation for historical work-order rows and execution
 * boundaries. Callers must hold rows whose old capability scope can no longer
 * be represented safely instead of retrying a transport failure forever.
 */
export function resolveBackgroundExecutionProfileForWorkOrder(input: Readonly<{
  modelTier: WorkModelTier;
  readonly: boolean;
  repositoryCapabilities: readonly string[];
}>): BackgroundExecutionProfileResolution {
  return resolveBackgroundExecutionProfile({
    version: BACKGROUND_EXECUTION_PROFILE_VERSION,
    provider: BACKGROUND_EXECUTION_PROVIDER,
    modelTier: input.modelTier,
    readonly: input.readonly,
    repositoryCapabilities: Array.isArray(input.repositoryCapabilities)
      ? [...input.repositoryCapabilities]
      : input.repositoryCapabilities,
  });
}

/**
 * Work orders never trust a caller-selected provider profile. This is the
 * single derivation point used when an immutable work-order revision is made.
 */
export function backgroundExecutionProfileForWorkOrder(input: Readonly<{
  modelTier: WorkModelTier;
  readonly: boolean;
  repositoryCapabilities: readonly string[];
  novitaPatchProposer?: NovitaPatchProposerAttestation;
}>): BackgroundExecutionProfile {
  const resolved = resolveBackgroundExecutionProfile({
    version: input.novitaPatchProposer
      ? BACKGROUND_DELEGATED_EXECUTION_PROFILE_VERSION
      : BACKGROUND_EXECUTION_PROFILE_VERSION,
    provider: BACKGROUND_EXECUTION_PROVIDER,
    modelTier: input.modelTier,
    readonly: input.readonly,
    repositoryCapabilities: [...input.repositoryCapabilities],
    ...(input.novitaPatchProposer ? { novitaPatchProposer: input.novitaPatchProposer } : {}),
  });
  if (!resolved.accepted) throw new Error(`Derived background execution profile is invalid: ${resolved.code}`);
  return resolved.profile;
}

/** A stable, non-secret representation for durable authority comparisons. */
export function canonicalBackgroundExecutionProfile(profile: BackgroundExecutionProfile): string {
  return JSON.stringify({
    version: profile.version,
    provider: profile.provider,
    modelTier: profile.modelTier,
    readonly: profile.readonly,
    authority: profile.authority,
    repositoryCapabilities: profile.repositoryCapabilities,
    ...(profile.version === BACKGROUND_DELEGATED_EXECUTION_PROFILE_VERSION
      ? { novitaPatchProposer: canonicalNovitaPatchProposerAttestation(profile.novitaPatchProposer) }
      : {}),
  });
}

export function backgroundExecutionProfilesEqual(left: unknown, right: unknown): boolean {
  const leftResolved = resolveBackgroundExecutionProfile(left);
  const rightResolved = resolveBackgroundExecutionProfile(right);
  return leftResolved.accepted
    && rightResolved.accepted
    && canonicalBackgroundExecutionProfile(leftResolved.profile) === canonicalBackgroundExecutionProfile(rightResolved.profile);
}
