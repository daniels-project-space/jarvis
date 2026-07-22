import "server-only";
import { getServiceSecrets } from "./vault";
import {
  evidenceProjectSourceAdmission,
  observeGitHubProjectSource,
  type ProjectSourceAdmission,
} from "./source-admission";

async function githubToken(): Promise<string | undefined> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const scoped = await getServiceSecrets("github").catch(() => ({}));
  return scoped.GITHUB_TOKEN || scoped.github_token || scoped.token || undefined;
}

export async function resolveProjectSourceAdmission(
  repository?: string | null,
  requestedBranch?: string,
): Promise<ProjectSourceAdmission> {
  if (!repository) return await evidenceProjectSourceAdmission();
  return await observeGitHubProjectSource({
    repository,
    requestedBranch,
    token: await githubToken(),
  });
}
