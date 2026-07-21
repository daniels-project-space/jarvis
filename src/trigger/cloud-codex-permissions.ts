import { dirname, isAbsolute, resolve } from "node:path";

export const CLOUD_CODEX_PERMISSION_PROFILE_ID = "jarvis_cloud_bridge";

export const CLOUD_CODEX_SENSITIVE_ENV_PATTERNS = Object.freeze([
  "*_KEY",
  "*_TOKEN",
  "*_SECRET",
  "*_PASSWORD",
  "CODEX_*",
  "OPENAI_*",
  "AWS_*",
  "GITHUB_*",
  "CONVEX_*",
  "TRIGGER_*",
]);

export type CloudCodexPermissionProfile = {
  id: typeof CLOUD_CODEX_PERMISSION_PROFILE_ID;
  config: Record<string, unknown>;
  environments: [];
  runtimeWorkspaceRoots: string[];
  expected: {
    activePermissionProfileId: typeof CLOUD_CODEX_PERMISSION_PROFILE_ID;
    sandbox: { type: "readOnly"; networkAccess: false };
  };
};

function absolutePath(value: string, label: string): string {
  if (!value || !isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return resolve(value);
}

export function buildCloudCodexPermissionProfile(input: {
  codexHome: string;
  controllerScratch: string;
  controllerAuthorityRoots?: Array<string | undefined>;
}): CloudCodexPermissionProfile {
  const codexHome = absolutePath(input.codexHome, "isolated CODEX_HOME");
  const controllerScratch = absolutePath(input.controllerScratch, "controller scratch");
  const denied = new Set<string>([
    codexHome,
    "/proc",
    dirname(controllerScratch),
    ...input.controllerAuthorityRoots
      ?.filter((value): value is string => Boolean(value && isAbsolute(value)))
      .map((value) => resolve(value)) ?? [],
  ]);
  denied.delete(controllerScratch);
  denied.delete("/");

  const filesystem: Record<string, unknown> = {
    ":minimal": "read",
    ":workspace_roots": { ".": "read" },
  };
  for (const path of denied) filesystem[path] = "deny";
  // The empty controller scratch is the sole host workspace root. It is more
  // specific than its denied authority parent and remains read-only.
  filesystem[controllerScratch] = "read";

  return {
    id: CLOUD_CODEX_PERMISSION_PROFILE_ID,
    config: {
      permissions: {
        [CLOUD_CODEX_PERMISSION_PROFILE_ID]: {
          filesystem,
          network: { enabled: false },
        },
      },
      web_search: "disabled",
      shell_environment_policy: {
        inherit: "none",
        ignore_default_excludes: false,
        exclude: [...CLOUD_CODEX_SENSITIVE_ENV_PATTERNS],
      },
      features: {
        shell_tool: false,
        unified_exec: false,
        apps: false,
        plugins: false,
        hooks: false,
        browser_use: false,
        computer_use: false,
        multi_agent: false,
      },
    },
    environments: [],
    runtimeWorkspaceRoots: [controllerScratch],
    expected: {
      activePermissionProfileId: CLOUD_CODEX_PERMISSION_PROFILE_ID,
      sandbox: { type: "readOnly", networkAccess: false },
    },
  };
}
