import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA = /^[a-f0-9]{40}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const DEFAULT_PRODUCTION_URL = "https://jarvis-orcin-six.vercel.app";

export function vercelProductionDeployArgs(input: { sha: string; branch: string }): string[] {
  if (!SHA.test(input.sha)) throw new Error("release SHA must be an exact 40-character Git commit");
  if (!BRANCH.test(input.branch) || input.branch.includes("..") || input.branch.endsWith("/")) {
    throw new Error("release branch is malformed");
  }
  return [
    "--yes", "vercel@59.3.0", "deploy", "--prod", "--yes",
    "--build-env", `RELEASE_SHA=${input.sha}`,
    "--env", `RELEASE_SHA=${input.sha}`,
    "--meta", `githubCommitSha=${input.sha}`,
    "--meta", `githubCommitRef=${input.branch}`,
    "--meta", "githubCommitOrg=daniels-project-space",
    "--meta", "githubCommitRepo=jarvis",
  ];
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

async function verifyHealth(productionUrl: string, sha: string): Promise<void> {
  const healthUrl = new URL("/api/health", productionUrl);
  const deadline = Date.now() + 60_000;
  let observed = "unavailable";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      const body = await response.json() as { ok?: unknown; revision?: unknown };
      observed = typeof body.revision === "string" ? body.revision : `http_${response.status}`;
      if (response.ok && body.ok === true && body.revision === sha) return;
    } catch (error) {
      observed = error instanceof Error ? error.name : "request_failed";
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
  }
  throw new Error(`production health did not attest ${sha}; observed ${observed}`);
}

export async function deployVercelProduction(): Promise<void> {
  if (!process.env.VERCEL_TOKEN?.trim()) throw new Error("VERCEL_TOKEN is required");
  const sha = git(["rev-parse", "HEAD"]);
  const branch = git(["branch", "--show-current"]);
  if (!branch) throw new Error("production deploy requires a named branch");
  const dirty = git(["status", "--porcelain", "--untracked-files=normal"]);
  if (dirty) throw new Error("production deploy requires a clean worktree");
  const remote = git(["ls-remote", "origin", `refs/heads/${branch}`]).split(/\s+/)[0] ?? "";
  if (remote !== sha) throw new Error("production deploy requires the exact commit pushed to its origin branch");

  const deployed = spawnSync("npx", vercelProductionDeployArgs({ sha, branch }), {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (deployed.error) throw deployed.error;
  if (deployed.status !== 0) throw new Error(`Vercel deploy exited with status ${deployed.status ?? "unknown"}`);

  const productionUrl = process.env.JARVIS_PUBLIC_URL?.trim() || DEFAULT_PRODUCTION_URL;
  await verifyHealth(productionUrl, sha);
  process.stdout.write(`${JSON.stringify({ status: "verified", revision: sha, productionUrl })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void deployVercelProduction().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Vercel production deploy failed"}\n`);
    process.exitCode = 1;
  });
}
