import { describe, expect, it, vi } from "vitest";
import { createGitHubIntegrationAdapter } from "./github-integration-adapter";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const TREE = "c".repeat(40);
const REPOSITORY_ID = "R_repo_node";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function adapter(fetchImpl: typeof fetch) {
  return createGitHubIntegrationAdapter({
    repository: "daniels-project-space/jarvis", repositoryNodeId: REPOSITORY_ID,
    remote: "https://github.com/daniels-project-space/jarvis.git",
    workerBranch: "jarvis/work/mission/job", integrationAttemptId: "attempt-1",
    createdAt: Date.parse("2026-07-21T00:00:00Z"), token: "test-token",
    fetchImpl, runGit: vi.fn(async () => ({ code: 0, out: "" })),
  });
}

describe("GitHub integration fetch contract", () => {
  it("uses one updateRefs GraphQL POST with exact beforeOid/afterOid and force false", async () => {
    const calls: Array<{ url: string; method: string; body?: any }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method: init?.method ?? "GET", body });
      if (url.endsWith("/graphql")) return json({ data: { updateRefs: { clientMutationId: body.variables.input.clientMutationId } } });
      return json({ object: { sha: BASE } });
    }) as unknown as typeof fetch;
    const github = adapter(fetchImpl);
    const effect = await github.prepareRefEffect({ effectId: "cas-1", branch: "jarvis/goal/x", expectedBaseSha: BASE, newHeadSha: HEAD, treeSha: TREE });
    expect(effect).toMatchObject({
      kind: "update_ref", providerIdentity: `${REPOSITORY_ID}:refs/heads/jarvis/goal/x`,
      method: "POST", target: "https://api.github.com/graphql#updateRefs", expectedBaseSha: BASE, headSha: HEAD,
    });
    expect(effect.requestDigest).toMatch(/^[0-9a-f]{64}$/);
    await expect(github.advanceRef({ effectId: "cas-1", branch: "jarvis/goal/x", expectedBaseSha: BASE, newHeadSha: HEAD }))
      .resolves.toMatchObject({ outcome: "applied", providerHeadSha: HEAD });
    const graph = calls.filter((call) => call.url.endsWith("/graphql"));
    expect(graph).toHaveLength(1);
    expect(graph[0].method).toBe("POST");
    expect(graph[0].body.variables.input).toEqual({
      repositoryId: REPOSITORY_ID,
      refUpdates: [{ name: "refs/heads/jarvis/goal/x", beforeOid: BASE, afterOid: HEAD, force: false }],
      clientMutationId: "cas-1",
    });
  });

  it("treats only REST 404 as absent; auth, server and network failures are errors", async () => {
    const missing = adapter(vi.fn(async () => json({ message: "Not Found" }, 404)) as unknown as typeof fetch);
    await expect(missing.readRef("jarvis/goal/missing")).resolves.toBeNull();
    for (const status of [401, 403, 500]) {
      const failed = adapter(vi.fn(async () => json({ message: "failure" }, status)) as unknown as typeof fetch);
      await expect(failed.readRef("jarvis/goal/x")).rejects.toThrow(`(${status})`);
    }
    const network = adapter(vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch);
    await expect(network.readRef("jarvis/goal/x")).rejects.toThrow("offline");
  });

  it("reconciles a lost GraphQL response by exact REST observation with zero duplicate writes", async () => {
    let head = BASE;
    let graphqlCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/graphql")) {
        graphqlCalls += 1;
        head = HEAD;
        throw new Error("response lost after commit");
      }
      return json({ object: { sha: head } });
    }) as unknown as typeof fetch;
    const github = adapter(fetchImpl);
    const result = await github.advanceRef({ effectId: "cas-lost", branch: "jarvis/goal/x", expectedBaseSha: BASE, newHeadSha: HEAD });
    expect(result.outcome).toBe("unknown");
    await expect(github.readRef("jarvis/goal/x")).resolves.toBe(HEAD);
    expect(graphqlCalls).toBe(1);
  });

  it("stages an immutable candidate object once and reconciles a lost create response", async () => {
    let commitExists = false;
    let commitPosts = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/git/trees/${TREE}`)) return json({ sha: TREE, tree: [] });
      if (url.endsWith(`/git/commits/${HEAD}`)) return commitExists
        ? json({ sha: HEAD, tree: { sha: TREE }, parents: [{ sha: BASE }, { sha: "d".repeat(40) }] })
        : json({ message: "Not Found" }, 404);
      if (url.endsWith("/git/commits") && init?.method === "POST") {
        commitPosts += 1;
        commitExists = true;
        throw new Error("commit response lost");
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const github = adapter(fetchImpl);
    const prepared = {
      status: "clean" as const, synthetic: true, headSha: HEAD, treeSha: TREE,
      candidate: {
        headSha: HEAD, treeSha: TREE, baseTreeSha: "e".repeat(40), entries: [],
        message: "JARVIS integration generation 1", parents: [BASE, "d".repeat(40)],
        actor: { name: "JARVIS integration controller", email: "jarvis@daniels-project-space.dev", date: "2026-07-21T00:00:00.000Z" },
      },
    };
    const prepare = vi.fn(async () => ({ replay: commitExists }));
    const observe = vi.fn(async () => true);
    await expect(github.stageCandidate(prepared, { prepare, observe })).resolves.toMatchObject({ outcome: "applied", providerHeadSha: HEAD });
    await expect(github.stageCandidate(prepared, { prepare, observe })).resolves.toMatchObject({ outcome: "applied", providerHeadSha: HEAD });
    expect(commitPosts).toBe(1);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ effectId: `stage-commit:attempt-1:${HEAD}`, observation: "applied" }));
  });

  it("blocks a wrong existing candidate commit without a write", async () => {
    let posts = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") posts += 1;
      if (url.endsWith(`/git/trees/${TREE}`)) return json({ sha: TREE, tree: [] });
      if (url.endsWith(`/git/commits/${HEAD}`)) return json({ sha: HEAD, tree: { sha: "f".repeat(40) }, parents: [] });
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const github = adapter(fetchImpl);
    const prepared = {
      status: "clean" as const, synthetic: true, headSha: HEAD, treeSha: TREE,
      candidate: { headSha: HEAD, treeSha: TREE, baseTreeSha: BASE, entries: [], message: "m", parents: [BASE, "d".repeat(40)], actor: { name: "n", email: "e", date: "2026-07-21T00:00:00.000Z" } },
    };
    await expect(github.stageCandidate(prepared, { prepare: vi.fn(async () => ({ replay: true })), observe: vi.fn(async () => true) }))
      .rejects.toThrow("wrong existing candidate commit blocked");
    expect(posts).toBe(0);
  });
});
