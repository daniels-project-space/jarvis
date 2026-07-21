import { describe, expect, it } from "vitest";
import {
  buildCloudCodexPermissionProfile,
  CLOUD_CODEX_PERMISSION_PROFILE_ID,
  CLOUD_CODEX_SENSITIVE_ENV_PATTERNS,
} from "./cloud-codex-permissions";

describe("cloud Codex permission construction", () => {
  it("builds the pinned read-only, network-denied profile from runtime paths", () => {
    const profile = buildCloudCodexPermissionProfile({
      codexHome: "/authority/codex-job-7",
      controllerScratch: "/tmp/work/controller-job-7",
      controllerAuthorityRoots: ["/authority", "/app"],
    });
    const permissions = profile.config.permissions as Record<string, {
      filesystem: Record<string, unknown>; network: { enabled: boolean };
    }>;
    const filesystem = permissions[CLOUD_CODEX_PERMISSION_PROFILE_ID].filesystem;
    expect(profile).toMatchObject({
      id: "jarvis_cloud_bridge", environments: [],
      runtimeWorkspaceRoots: ["/tmp/work/controller-job-7"],
      expected: { activePermissionProfileId: "jarvis_cloud_bridge", sandbox: { type: "readOnly", networkAccess: false } },
    });
    expect(filesystem).toMatchObject({
      ":minimal": "read", ":workspace_roots": { ".": "read" },
      "/authority/codex-job-7": "deny", "/proc": "deny", "/tmp/work": "deny",
      "/authority": "deny", "/app": "deny", "/tmp/work/controller-job-7": "read",
    });
    expect(permissions[CLOUD_CODEX_PERMISSION_PROFILE_ID].network.enabled).toBe(false);
  });

  it("denies each actual isolated CODEX_HOME instead of a static path", () => {
    const one = buildCloudCodexPermissionProfile({ codexHome: "/auth/one", controllerScratch: "/scratch/one" });
    const two = buildCloudCodexPermissionProfile({ codexHome: "/auth/two", controllerScratch: "/scratch/two" });
    const filesystem = (profile: typeof one) => ((profile.config.permissions as Record<string, { filesystem: Record<string, unknown> }>)[profile.id].filesystem);
    expect(filesystem(one)["/auth/one"]).toBe("deny");
    expect(filesystem(one)["/auth/two"]).toBeUndefined();
    expect(filesystem(two)["/auth/two"]).toBe("deny");
  });

  it("passes no shell environment and retains every sensitive exclusion", () => {
    const profile = buildCloudCodexPermissionProfile({ codexHome: "/auth/job", controllerScratch: "/scratch/job" });
    expect(profile.config.shell_environment_policy).toEqual({
      inherit: "none", ignore_default_excludes: false, exclude: [...CLOUD_CODEX_SENSITIVE_ENV_PATTERNS],
    });
    expect(CLOUD_CODEX_SENSITIVE_ENV_PATTERNS).toEqual([
      "*_KEY", "*_TOKEN", "*_SECRET", "*_PASSWORD", "CODEX_*", "OPENAI_*", "AWS_*",
      "GITHUB_*", "CONVEX_*", "TRIGGER_*",
    ]);
    expect(profile.config.features).toMatchObject({ shell_tool: false, unified_exec: false });
    expect(profile.config.web_search).toBe("disabled");
  });

  it("refuses relative or absent authority paths", () => {
    expect(() => buildCloudCodexPermissionProfile({ codexHome: "relative", controllerScratch: "/scratch" })).toThrow(/absolute/);
    expect(() => buildCloudCodexPermissionProfile({ codexHome: "/auth", controllerScratch: "relative" })).toThrow(/absolute/);
  });
});
