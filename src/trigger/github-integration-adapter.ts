import { createHash } from "node:crypto";
import type {
  IntegrationAdapter,
  IntegrationHooks,
  PreparedIntegration,
  ProviderEffect,
  ProviderWriteResult,
} from "./mission-integration";

type GitResult = { code: number | null; out: string };
type GitRunner = (args: string[], env?: NodeJS.ProcessEnv) => Promise<GitResult>;
type FetchLike = typeof fetch;

type TreeEntry = { path: string; mode?: string; type?: "blob" | "tree" | "commit"; sha: string | null };
type SyntheticCandidate = {
  headSha: string;
  treeSha: string;
  baseTreeSha: string;
  entries: TreeEntry[];
  message: string;
  parents: [string, string];
  actor: { name: string; email: string; date: string };
};

const API_VERSION = "2022-11-28";
const OID = /^[0-9a-f]{40,64}$/i;

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const compact = (value: unknown) => JSON.stringify(value).slice(0, 8_000);

export class GitHubProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "GitHubProviderError";
  }
}

function splitRepository(repository: string) {
  const [owner, name, ...rest] = repository.split("/");
  if (!owner || !name || rest.length) throw new Error("GitHub integration repository must be canonical owner/repo");
  return { owner, name };
}

function encodeRef(ref: string) {
  return ref.split("/").map(encodeURIComponent).join("/");
}

async function jsonResponse(response: Response) {
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 2_000) }; }
  return { body, exact: compact(body) };
}

export function createGitHubIntegrationAdapter(options: {
  repository: string;
  repositoryNodeId?: string;
  remote: string;
  workerBranch: string;
  integrationAttemptId: string;
  createdAt: number;
  token: string;
  runGit: GitRunner;
  fetchImpl?: FetchLike;
  gitEnv?: NodeJS.ProcessEnv;
  readGitObject?: (sha: string) => Promise<Buffer>;
}): IntegrationAdapter {
  const { owner, name } = splitRepository(options.repository);
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiRoot = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${options.token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": API_VERSION,
  };
  let repositoryNodeId = options.repositoryNodeId;

  const request = async (path: string, init: RequestInit = {}) => fetchImpl(`${apiRoot}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });

  const identity = async () => {
    if (repositoryNodeId) return repositoryNodeId;
    const response = await request("");
    const parsed = await jsonResponse(response);
    if (!response.ok || typeof parsed.body?.node_id !== "string") {
      throw new GitHubProviderError(`GitHub repository identity failed (${response.status}): ${parsed.exact}`, response.status);
    }
    repositoryNodeId = parsed.body.node_id;
    return repositoryNodeId;
  };

  const getObject = async (kind: "blobs" | "trees" | "commits", sha: string) => {
    const response = await request(`/git/${kind}/${sha}`);
    if (response.status === 404) return { exists: false as const };
    const parsed = await jsonResponse(response);
    if (!response.ok) throw new GitHubProviderError(`GitHub ${kind} observation failed (${response.status}): ${parsed.exact}`, response.status);
    if (parsed.body?.sha !== sha) throw new GitHubProviderError(`GitHub ${kind} identity mismatch for ${sha}`);
    return { exists: true as const, response: parsed.exact, body: parsed.body };
  };

  const observeCandidate = async (candidate: SyntheticCandidate, kind: ProviderEffect["kind"], sha: string) => {
    const plural = kind === "stage_blob" ? "blobs" : kind === "stage_tree" ? "trees" : "commits";
    const observed = await getObject(plural, sha);
    if (!observed.exists) return observed;
    if (kind === "stage_tree" && observed.body?.sha !== candidate.treeSha) throw new GitHubProviderError("wrong existing candidate tree blocked");
    if (kind === "stage_commit") {
      const parents = Array.isArray(observed.body?.parents) ? observed.body.parents.map((parent: any) => parent.sha) : [];
      if (observed.body?.tree?.sha !== candidate.treeSha || parents.join(",") !== candidate.parents.join(",")) {
        throw new GitHubProviderError("wrong existing candidate commit blocked");
      }
    }
    return observed;
  };

  const applyObjectEffect = async (
    candidate: SyntheticCandidate,
    hooks: IntegrationHooks,
    effect: ProviderEffect,
    path: string,
    body: unknown,
  ): Promise<ProviderWriteResult> => {
    const persist = async (observation: Parameters<IntegrationHooks["observe"]>[0]) => {
      const accepted = await hooks.observe(observation);
      return accepted ? null : { outcome: "unknown" as const, providerResponse: "durable-observation-fence-lost" };
    };
    const prepared = await hooks.prepare(effect);
    if (!prepared) return { outcome: "unknown" };
    if (prepared.replay && prepared.observation === "not_applied") return { outcome: "not_applied", providerResponse: "reconciled:prior-rejection" };
    let prior;
    try {
      prior = await observeCandidate(candidate, effect.kind, effect.headSha);
    } catch (error) {
      if (error instanceof GitHubProviderError && error.message.startsWith("wrong existing")) throw error;
      const lost = await persist({ effectId: effect.effectId, observation: "unknown", providerResponse: `observation:${String(error).slice(0, 300)}` });
      if (lost) return lost;
      return { outcome: "unknown", providerResponse: "observation:failed" };
    }
    if (prior.exists) {
      const lost = await persist({ effectId: effect.effectId, observation: "applied", providerHeadSha: effect.headSha, providerResponse: prior.response });
      if (lost) return lost;
      return { outcome: "applied", providerHeadSha: effect.headSha, providerResponse: prior.response };
    }
    let response: Response;
    try {
      response = await request(path, { method: "POST", body: JSON.stringify(body) });
    } catch (error) {
      try {
        const reconciled = await observeCandidate(candidate, effect.kind, effect.headSha);
        if (reconciled.exists) {
          const lost = await persist({ effectId: effect.effectId, observation: "applied", providerHeadSha: effect.headSha, providerResponse: reconciled.response });
          if (lost) return lost;
          return { outcome: "applied", providerHeadSha: effect.headSha, providerResponse: reconciled.response };
        }
      } catch (reconciliationError) {
        const lost = await persist({ effectId: effect.effectId, observation: "unknown", providerResponse: `network:${String(error).slice(0, 160)}; observation:${String(reconciliationError).slice(0, 160)}` });
        if (lost) return lost;
        return { outcome: "unknown", providerResponse: "network-and-observation:ambiguous" };
      }
      const lost = await persist({ effectId: effect.effectId, observation: "unknown", providerResponse: `network:${String(error).slice(0, 300)}` });
      if (lost) return lost;
      return { outcome: "unknown", providerResponse: "network:ambiguous" };
    }
    const parsed = await jsonResponse(response);
    if (!response.ok) {
      // GitHub may return 409/422 after a concurrent create committed the
      // exact immutable object. Observe identity before classifying the race.
      const reconciled = await observeCandidate(candidate, effect.kind, effect.headSha);
      const observation = reconciled.exists ? "applied" as const : "not_applied" as const;
      const lost = await persist({ effectId: effect.effectId, observation,
        providerHeadSha: reconciled.exists ? effect.headSha : undefined, providerResponse: parsed.exact });
      if (lost) return lost;
      return { outcome: observation, providerHeadSha: reconciled.exists ? effect.headSha : undefined, providerResponse: parsed.exact };
    }
    if (parsed.body?.sha !== effect.headSha) {
      const lost = await persist({ effectId: effect.effectId, observation: "not_applied", providerResponse: parsed.exact });
      if (lost) return lost;
      return { outcome: "not_applied", providerResponse: parsed.exact };
    }
    const lost = await persist({ effectId: effect.effectId, observation: "applied", providerHeadSha: effect.headSha, providerResponse: parsed.exact });
    if (lost) return lost;
    return { outcome: "applied", providerHeadSha: effect.headSha, providerResponse: parsed.exact };
  };

  const requiredGit = async (args: string[], label: string) => {
    const result = await options.runGit(args, options.gitEnv);
    if (result.code !== 0) throw new Error(`${label} failed (${String(result.code)}): ${result.out.slice(-500)}`);
    return result.out.trim();
  };

  const buildEntries = async (baseSha: string, treeSha: string): Promise<TreeEntry[]> => {
    const changed = await options.runGit(["diff", "--name-status", "--no-renames", "-z", baseSha, treeSha], options.gitEnv);
    if (changed.code !== 0) throw new Error(`merge tree change enumeration failed (${String(changed.code)}): ${changed.out.slice(-500)}`);
    const tokens = changed.out.split("\0").filter(Boolean);
    const entries: TreeEntry[] = [];
    for (let index = 0; index < tokens.length; index += 2) {
      const status = tokens[index];
      const path = tokens[index + 1];
      if (!path) throw new Error("merge tree returned a malformed changed path");
      if (status.startsWith("D")) {
        entries.push({ path, sha: null });
        continue;
      }
      const line = await requiredGit(["ls-tree", treeSha, "--", path], `merge tree entry ${path}`);
      const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40,64})\t/.exec(line);
      if (!match) throw new Error(`merge tree entry ${path} is malformed`);
      entries.push({ path, mode: match[1], type: match[2] as TreeEntry["type"], sha: match[3] });
    }
    return entries;
  };

  const refMutation = async (effectId: string, branch: string, expectedBaseSha: string, newHeadSha: string) => {
    const repositoryId = await identity();
    const query = `mutation UpdateIntegrationRef($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }`;
    const variables = {
      input: {
        repositoryId,
        refUpdates: [{ name: `refs/heads/${branch}`, beforeOid: expectedBaseSha, afterOid: newHeadSha, force: false }],
        clientMutationId: effectId,
      },
    };
    return { repositoryId, query, variables };
  };

  return {
    readRef: async (branch) => {
      const response = await request(`/git/ref/${encodeRef(`heads/${branch}`)}`);
      if (response.status === 404) return null;
      const parsed = await jsonResponse(response);
      if (!response.ok) throw new GitHubProviderError(`GitHub ref observation failed (${response.status}): ${parsed.exact}`, response.status);
      const sha = parsed.body?.object?.sha;
      if (!OID.test(String(sha ?? ""))) throw new GitHubProviderError("GitHub ref response did not contain an exact object identity");
      return String(sha);
    },
    prepareMerge: async ({ integrationBaseSha, workerHeadSha, workerTreeSha, generation }) => {
      const fetchedWorker = await options.runGit(["fetch", "--no-tags", options.remote, `refs/heads/${options.workerBranch}`], options.gitEnv);
      if (fetchedWorker.code !== 0) return { status: "deferred", reason: "reviewed worker ref could not be materialized" };
      const fetchedHead = await requiredGit(["rev-parse", "FETCH_HEAD"], "fetched worker head");
      if (fetchedHead !== workerHeadSha) return { status: "stale", reason: `fetched worker head ${fetchedHead} does not equal reviewed head ${workerHeadSha}` };
      const fetchedTree = await requiredGit(["rev-parse", `${fetchedHead}^{tree}`], "fetched worker tree");
      if (fetchedTree !== workerTreeSha) return { status: "stale", reason: `fetched worker tree ${fetchedTree} does not equal signed reviewed tree ${workerTreeSha}` };
      const fetchedBase = await options.runGit(["fetch", "--no-tags", options.remote, integrationBaseSha], options.gitEnv);
      if (fetchedBase.code !== 0) return { status: "deferred", reason: "integration base commit could not be materialized" };
      const ancestor = await options.runGit(["merge-base", "--is-ancestor", integrationBaseSha, workerHeadSha], options.gitEnv);
      if (ancestor.code === 0) return { status: "clean", headSha: workerHeadSha, treeSha: workerTreeSha, synthetic: false };
      if (ancestor.code !== 1) return { status: "deferred", reason: `merge-base execution failed (${String(ancestor.code)}): ${ancestor.out.slice(-500)}` };
      const merged = await options.runGit(["merge-tree", "--write-tree", integrationBaseSha, workerHeadSha], options.gitEnv);
      if (merged.code !== 0) return { status: "conflict", reason: merged.out.slice(-800) || "semantic merge conflict" };
      const treeSha = merged.out.trim().split(/\s+/)[0];
      if (!OID.test(treeSha)) return { status: "deferred", reason: "sandbox did not produce an exact merge tree" };
      const fixedDate = new Date(options.createdAt).toISOString();
      const message = `JARVIS integration generation ${generation}`;
      const actor = { name: "JARVIS integration controller", email: "jarvis@daniels-project-space.dev", date: fixedDate };
      const commit = await options.runGit(
        ["commit-tree", treeSha, "-p", integrationBaseSha, "-p", workerHeadSha, "-m", message],
        { ...(options.gitEnv ?? process.env), GIT_AUTHOR_NAME: actor.name, GIT_AUTHOR_EMAIL: actor.email, GIT_AUTHOR_DATE: fixedDate,
          GIT_COMMITTER_NAME: actor.name, GIT_COMMITTER_EMAIL: actor.email, GIT_COMMITTER_DATE: fixedDate } as NodeJS.ProcessEnv,
      );
      const headSha = commit.out.trim().split(/\s+/)[0];
      if (commit.code !== 0 || !OID.test(headSha)) return { status: "deferred", reason: "sandbox could not create the deterministic merge commit" };
      const baseTreeSha = await requiredGit(["rev-parse", `${integrationBaseSha}^{tree}`], "integration base tree");
      const entries = await buildEntries(integrationBaseSha, treeSha);
      return {
        status: "clean",
        headSha,
        treeSha,
        synthetic: true,
        candidate: { headSha, treeSha, baseTreeSha, entries, message, parents: [integrationBaseSha, workerHeadSha], actor } satisfies SyntheticCandidate,
      };
    },
    stageCandidate: async (prepared, hooks) => {
      if (!prepared.synthetic) return { outcome: "applied", providerHeadSha: prepared.headSha };
      const candidate = prepared.candidate as SyntheticCandidate | undefined;
      if (!candidate || candidate.headSha !== prepared.headSha || candidate.treeSha !== prepared.treeSha) {
        throw new Error("synthetic candidate identity is missing or inconsistent");
      }
      const repoId = await identity();
      for (const entry of candidate.entries) {
        if (entry.type !== "blob" || !entry.sha) continue;
        const existing = await getObject("blobs", entry.sha);
        if (existing.exists) continue;
        if (!options.readGitObject) throw new Error("binary-safe Git object reader is required for candidate blob staging");
        const bytes = await options.readGitObject(entry.sha);
        const body = { content: bytes.toString("base64"), encoding: "base64" };
        const effect: ProviderEffect = {
          effectId: `stage-blob:${options.integrationAttemptId}:${entry.sha}`,
          kind: "stage_blob", provider: "github", providerIdentity: `${repoId}:blob:${entry.sha}`,
          method: "POST", target: `/git/blobs`, requestDigest: digest(body), headSha: entry.sha, treeSha: candidate.treeSha,
        };
        const staged = await applyObjectEffect(candidate, hooks, effect, "/git/blobs", body);
        if (staged.outcome !== "applied") return staged;
      }
      const treeBody = { base_tree: candidate.baseTreeSha, tree: candidate.entries };
      const treeEffect: ProviderEffect = {
        effectId: `stage-tree:${options.integrationAttemptId}:${candidate.treeSha}`,
        kind: "stage_tree", provider: "github", providerIdentity: `${repoId}:tree:${candidate.treeSha}`,
        method: "POST", target: "/git/trees", requestDigest: digest(treeBody), headSha: candidate.treeSha, treeSha: candidate.treeSha,
      };
      const tree = await applyObjectEffect(candidate, hooks, treeEffect, "/git/trees", treeBody);
      if (tree.outcome !== "applied") return tree;
      const commitBody = { message: candidate.message, tree: candidate.treeSha, parents: candidate.parents, author: candidate.actor, committer: candidate.actor };
      const commitEffect: ProviderEffect = {
        effectId: `stage-commit:${options.integrationAttemptId}:${candidate.headSha}`,
        kind: "stage_commit", provider: "github", providerIdentity: `${repoId}:commit:${candidate.headSha}`,
        method: "POST", target: "/git/commits", requestDigest: digest(commitBody), headSha: candidate.headSha, treeSha: candidate.treeSha,
      };
      return await applyObjectEffect(candidate, hooks, commitEffect, "/git/commits", commitBody);
    },
    prepareRefEffect: async ({ effectId, branch, expectedBaseSha, newHeadSha, treeSha }) => {
      const mutation = await refMutation(effectId, branch, expectedBaseSha, newHeadSha);
      return {
        effectId, kind: "update_ref", provider: "github",
        providerIdentity: `${mutation.repositoryId}:refs/heads/${branch}`,
        method: "POST", target: "https://api.github.com/graphql#updateRefs",
        requestDigest: digest({ query: mutation.query, variables: mutation.variables }),
        expectedBaseSha, headSha: newHeadSha, treeSha,
      };
    },
    advanceRef: async ({ effectId, branch, expectedBaseSha, newHeadSha }) => {
      const mutation = await refMutation(effectId, branch, expectedBaseSha, newHeadSha);
      let response: Response;
      try {
        response = await fetchImpl("https://api.github.com/graphql", {
          method: "POST", headers, body: JSON.stringify({ query: mutation.query, variables: mutation.variables }),
        });
      } catch (error) {
        return { outcome: "unknown", providerResponse: `network:${String(error).slice(0, 300)}` };
      }
      const parsed = await jsonResponse(response);
      if (!response.ok) return { outcome: "unknown", providerResponse: `http:${response.status}:${parsed.exact}` };
      if (Array.isArray(parsed.body?.errors) && parsed.body.errors.length) {
        return { outcome: "not_applied", providerResponse: parsed.exact };
      }
      if (parsed.body?.data?.updateRefs?.clientMutationId !== effectId) {
        return { outcome: "unknown", providerResponse: parsed.exact };
      }
      return { outcome: "applied", providerHeadSha: newHeadSha, providerResponse: parsed.exact };
    },
  };
}
