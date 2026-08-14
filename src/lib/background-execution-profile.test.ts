import { describe, expect, it } from "vitest";
import {
  BACKGROUND_EXECUTION_PROVIDER,
  backgroundExecutionProfileForWorkOrder,
  resolveBackgroundExecutionProfile,
  resolveBackgroundExecutionProfileForWorkOrder,
} from "./background-execution-profile";
import { workOrderRevisionForJob, workOrderRevisionRowBinding } from "./work-order-revision";

function accepted(value: unknown = {}) {
  const result = resolveBackgroundExecutionProfile(value);
  expect(result.accepted).toBe(true);
  if (!result.accepted) throw new Error(result.reason);
  return result.profile;
}

describe("background execution profile", () => {
  it("derives an immutable, Codex-only profile with denied external authority", () => {
    const profile = accepted({
      provider: "codex",
      modelTier: "sol",
      readonly: false,
      repositoryCapabilities: ["repository_exec", "repository_write_file"],
      authority: { external: false, apps: false, secrets: false, network: false },
    });

    expect(profile).toMatchObject({
      version: 1,
      provider: BACKGROUND_EXECUTION_PROVIDER,
      modelTier: "sol",
      readonly: false,
      authority: { external: false, apps: false, secrets: false, network: false },
      repositoryCapabilities: ["repository_exec", "repository_write_file"],
    });
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.authority)).toBe(true);
    expect(Object.isFrozen(profile.repositoryCapabilities)).toBe(true);
  });

  it("uses the conservative current-Codex defaults", () => {
    expect(accepted()).toMatchObject({
      provider: BACKGROUND_EXECUTION_PROVIDER,
      modelTier: "terra",
      readonly: true,
      repositoryCapabilities: [
        "repository_read_file",
        "repository_list_files",
      ],
    });
  });

  it("round-trips a durable profile including its protocol version", () => {
    const profile = accepted({ modelTier: "luna", readonly: true });
    expect(resolveBackgroundExecutionProfile(profile)).toMatchObject({ accepted: true, profile });
  });

  it("derives a work-order profile instead of accepting a caller provider", () => {
    expect(backgroundExecutionProfileForWorkOrder({
      modelTier: "terra",
      readonly: false,
      repositoryCapabilities: ["repository_exec", "repository_read_file", "repository_write_file"],
    })).toMatchObject({
      provider: BACKGROUND_EXECUTION_PROVIDER,
      modelTier: "terra",
      readonly: false,
    });
  });

  it("holds a legacy readonly work order whose old scope included exec", () => {
    const safeBinding = workOrderRevisionForJob({
      jobId: "legacy-readonly-job",
      agentId: "atlas",
      model: "terra",
      readonly: true,
      task: "Inspect the repository without changing it.",
      policyTask: "Inspect the repository without changing it.",
      schedulingBindingDigest: "a".repeat(64),
      canonicalProjectId: "legacy-project",
      sourceProvider: "none",
      sourceObservedAt: 1,
      sourceAdmissionDigest: "b".repeat(64),
      toolScope: ["repository_read_file", "repository_list_files"],
      mcp: [],
      approvalRequired: false,
    }, { revision: 1 });
    expect(safeBinding).not.toBeNull();
    if (!safeBinding) throw new Error("fixture work order was not admitted");

    const legacyRow: Record<string, unknown> = {
      ...safeBinding,
      toolScope: ["repository_exec", "repository_read_file", "repository_list_files"],
    };
    delete legacyRow.backgroundExecutionProfile;

    expect(resolveBackgroundExecutionProfileForWorkOrder({
      modelTier: "terra",
      readonly: true,
      repositoryCapabilities: legacyRow.toolScope as string[],
    })).toMatchObject({ accepted: false, code: "invalid_repository_capability" });
    expect(workOrderRevisionRowBinding(legacyRow)).toBeNull();
  });

  it.each(["novita", "open-weight", "openai-api", "untrusted-provider"])(
    "rejects untrusted provider %s",
    (provider) => {
      expect(resolveBackgroundExecutionProfile({ provider })).toMatchObject({
        accepted: false,
        code: "unsupported_provider",
      });
    },
  );

  it.each(["external", "apps", "secrets", "network"] as const)(
    "rejects requested %s authority",
    (authority) => {
      expect(resolveBackgroundExecutionProfile({
        authority: { [authority]: true },
      })).toMatchObject({
        accepted: false,
        code: "forbidden_authority",
      });
    },
  );

  it("rejects malformed or expanded untrusted profile shapes", () => {
    expect(resolveBackgroundExecutionProfile(null)).toMatchObject({
      accepted: false,
      code: "invalid_profile",
    });
    expect(resolveBackgroundExecutionProfile({ provider: "codex", endpoint: "https://untrusted.example" })).toMatchObject({
      accepted: false,
      code: "invalid_profile",
    });
    expect(resolveBackgroundExecutionProfile({ authority: { apps: "false" } })).toMatchObject({
      accepted: false,
      code: "invalid_profile",
    });
  });

  it("validates repository capabilities against the readonly admission", () => {
    expect(resolveBackgroundExecutionProfile({
      readonly: true,
      repositoryCapabilities: ["repository_write_file"],
    })).toMatchObject({
      accepted: false,
      code: "invalid_repository_capability",
    });
    expect(resolveBackgroundExecutionProfile({
      readonly: false,
      repositoryCapabilities: ["repository_read_file", "repository_read_file"],
    })).toMatchObject({
      accepted: false,
      code: "invalid_repository_capability",
    });
    expect(resolveBackgroundExecutionProfile({
      readonly: false,
      repositoryCapabilities: ["repository_read_file", "github_write"],
    })).toMatchObject({
      accepted: false,
      code: "invalid_repository_capability",
    });
  });
});
