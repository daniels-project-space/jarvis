import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createGitHubIntegrationAdapter, GITHUB_REST_API_VERSION } from "./github-integration-adapter";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const TREE = "c".repeat(40);
const REPOSITORY_ID = "R_repo_node";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function adapter(fetchImpl: typeof fetch, readGitObject?: (sha: string) => Promise<Buffer>) {
  return createGitHubIntegrationAdapter({
    repository: "daniels-project-space/jarvis", repositoryNodeId: REPOSITORY_ID,
    remote: "https://github.com/daniels-project-space/jarvis.git",
    workerBranch: "jarvis/work/mission/job", integrationAttemptId: "attempt-1",
    createdAt: Date.parse("2026-07-21T00:00:00Z"), token: "test-token",
    fetchImpl, readGitObject, runGit: vi.fn(async () => ({ code: 0, out: "" })),
  });
}

describe("GitHub integration fetch contract", () => {
  it("attests the exact local candidate commit/tree without a provider call", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-goal-fence-"));
    const localGit = (args: string[]) => {
      try {
        return { code: 0, out: execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
      } catch (error) {
        const failed = error as { status?: number; stdout?: string; stderr?: string };
        return { code: failed.status ?? 1, out: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
      }
    };
    localGit(["init"]);
    localGit(["config", "user.email", "test@example.test"]);
    localGit(["config", "user.name", "Test"]);
    writeFileSync(join(root, "vercel.json"), JSON.stringify({ $schema: "schema", git: { deploymentEnabled: false } }));
    localGit(["add", "vercel.json"]);
    localGit(["commit", "-m", "candidate"]);
    const headSha = localGit(["rev-parse", "HEAD"]).out.trim();
    const treeSha = localGit(["rev-parse", "HEAD^{tree}"]).out.trim();
    const provider = vi.fn(async () => { throw new Error("provider call forbidden"); }) as unknown as typeof fetch;
    const github = createGitHubIntegrationAdapter({
      repository: "daniels-project-space/jarvis", repositoryNodeId: REPOSITORY_ID,
      remote: "fixture", workerBranch: "jarvis/work/x", integrationAttemptId: "fence",
      createdAt: 1, token: "test", fetchImpl: provider,
      runGit: vi.fn(async (args) => localGit(args)),
      readGitObject: async (sha) => execFileSync("git", ["cat-file", "blob", sha], { cwd: root }),
    });
    await expect(github.attestDeploymentFence({ headSha, treeSha })).resolves.toBeUndefined();
    await expect(github.attestDeploymentFence({ headSha, treeSha: "f".repeat(40) })).rejects.toThrow("does not attest exact tree");
    expect(provider).not.toHaveBeenCalled();
  });

  it("uses one updateRefs GraphQL POST with exact beforeOid/afterOid and force false", async () => {
    const calls: Array<{ url: string; method: string; body?: any }> = [];
    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method: init?.method ?? "GET", body });
      if (url.endsWith("/graphql")) return json({ data: { updateRefs: { clientMutationId: body.variables.input.clientMutationId } } });
      return json({ object: { sha: BASE } });
    });
    const fetchImpl = mockFetch as unknown as typeof fetch;
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
    const graphCall = mockFetch.mock.calls.find(([input]) => String(input).endsWith("/graphql"));
    expect(new Headers(graphCall?.[1]?.headers).get("X-GitHub-Api-Version")).toBe(GITHUB_REST_API_VERSION);
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
    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/graphql")) {
        graphqlCalls += 1;
        head = HEAD;
        throw new Error("response lost after commit");
      }
      return json({ object: { sha: head } });
    });
    const fetchImpl = mockFetch as unknown as typeof fetch;
    const github = adapter(fetchImpl);
    const result = await github.advanceRef({ effectId: "cas-lost", branch: "jarvis/goal/x", expectedBaseSha: BASE, newHeadSha: HEAD });
    expect(result.outcome).toBe("unknown");
    await expect(github.readRef("jarvis/goal/x")).resolves.toBe(HEAD);
    expect(graphqlCalls).toBe(1);
  });

  it("classifies a non-2xx updateRefs response as ambiguous and permits exact read reconciliation", async () => {
    let head = BASE;
    let graphqlCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/graphql")) {
        graphqlCalls += 1; head = HEAD;
        return json({ message: "gateway lost upstream response" }, 502);
      }
      return json({ object: { sha: head } });
    }) as unknown as typeof fetch;
    const github = adapter(fetchImpl);
    await expect(github.advanceRef({ effectId: "cas-http-lost", branch: "jarvis/goal/x", expectedBaseSha: BASE, newHeadSha: HEAD }))
      .resolves.toMatchObject({ outcome: "unknown", providerResponse: expect.stringContaining("http:502") });
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

  it("stages arbitrary blob bytes without UTF-8 corruption", async () => {
    const blobSha = "1".repeat(40);
    const binary = Buffer.from([0, 255, 254, 128, 10, 65]);
    let postedContent = "";
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/git/blobs/${blobSha}`)) return json({ message: "Not Found" }, 404);
      if (url.endsWith("/git/blobs") && init?.method === "POST") {
        postedContent = JSON.parse(String(init.body)).content;
        return json({ sha: blobSha });
      }
      if (url.endsWith(`/git/trees/${TREE}`)) return json({ sha: TREE, tree: [] });
      if (url.endsWith(`/git/commits/${HEAD}`)) return json({ sha: HEAD, tree: { sha: TREE }, parents: [{ sha: BASE }, { sha: "d".repeat(40) }] });
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const github = adapter(fetchImpl, async () => binary);
    const prepared = { status: "clean" as const, synthetic: true, headSha: HEAD, treeSha: TREE, candidate: {
      headSha: HEAD, treeSha: TREE, baseTreeSha: "e".repeat(40), entries: [{ path: "binary.dat", mode: "100644", type: "blob" as const, sha: blobSha }],
      message: "JARVIS integration generation 1", parents: [BASE, "d".repeat(40)],
      actor: { name: "JARVIS integration controller", email: "jarvis@daniels-project-space.dev", date: "2026-07-21T00:00:00.000Z" },
    } };
    await expect(github.stageCandidate(prepared, { prepare: vi.fn(async () => ({ replay: false })), observe: vi.fn(async () => true) }))
      .resolves.toMatchObject({ outcome: "applied" });
    expect(Buffer.from(postedContent, "base64")).toEqual(binary);
  });

  it("reconciles an exact non-2xx create race after observation", async () => {
    let exists = false;
    let posts = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/git/trees/${TREE}`)) return json({ sha: TREE, tree: [] });
      if (url.endsWith(`/git/commits/${HEAD}`)) return exists
        ? json({ sha: HEAD, tree: { sha: TREE }, parents: [{ sha: BASE }, { sha: "d".repeat(40) }] })
        : json({ message: "Not Found" }, 404);
      if (url.endsWith("/git/commits") && init?.method === "POST") {
        posts += 1; exists = true; return json({ message: "already exists" }, 422);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const github = adapter(fetchImpl);
    const prepared = { status: "clean" as const, synthetic: true, headSha: HEAD, treeSha: TREE, candidate: {
      headSha: HEAD, treeSha: TREE, baseTreeSha: "e".repeat(40), entries: [], message: "JARVIS integration generation 1",
      parents: [BASE, "d".repeat(40)], actor: { name: "JARVIS integration controller", email: "jarvis@daniels-project-space.dev", date: "2026-07-21T00:00:00.000Z" },
    } };
    await expect(github.stageCandidate(prepared, { prepare: vi.fn(async () => ({ replay: false })), observe: vi.fn(async () => true) }))
      .resolves.toMatchObject({ outcome: "applied", providerHeadSha: HEAD });
    expect(posts).toBe(1);
  });

  it.each(["blob", "tree"] as const)("reconciles lost %s-create responses with one write", async (lostKind) => {
    const blobSha = "1".repeat(40);
    let blobExists = false;
    let treeExists = false;
    let writes = 0;
    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/git/blobs/${blobSha}`)) return blobExists ? json({ sha: blobSha }) : json({ message: "Not Found" }, 404);
      if (url.endsWith("/git/blobs") && init?.method === "POST") {
        writes += 1; blobExists = true;
        if (lostKind === "blob") throw new Error("blob response lost");
        return json({ sha: blobSha });
      }
      if (url.endsWith(`/git/trees/${TREE}`)) return treeExists ? json({ sha: TREE, tree: [] }) : json({ message: "Not Found" }, 404);
      if (url.endsWith("/git/trees") && init?.method === "POST") {
        writes += 1; treeExists = true;
        if (lostKind === "tree") throw new Error("tree response lost");
        return json({ sha: TREE });
      }
      if (url.endsWith(`/git/commits/${HEAD}`)) return json({ sha: HEAD, tree: { sha: TREE }, parents: [{ sha: BASE }, { sha: "d".repeat(40) }] });
      throw new Error(`unexpected fetch ${url}`);
    });
    const fetchImpl = mockFetch as unknown as typeof fetch;
    const github = adapter(fetchImpl, async () => Buffer.from([0, 255, 1]));
    const prepared = { status: "clean" as const, synthetic: true, headSha: HEAD, treeSha: TREE, candidate: {
      headSha: HEAD, treeSha: TREE, baseTreeSha: "e".repeat(40),
      entries: [{ path: "asset.bin", mode: "100644", type: "blob" as const, sha: blobSha }],
      message: "JARVIS integration generation 1", parents: [BASE, "d".repeat(40)],
      actor: { name: "JARVIS integration controller", email: "jarvis@daniels-project-space.dev", date: "2026-07-21T00:00:00.000Z" },
    } };
    await expect(github.stageCandidate(prepared, { prepare: vi.fn(async () => ({ replay: false })), observe: vi.fn(async () => true) }))
      .resolves.toMatchObject({ outcome: "applied" });
    expect(writes).toBe(2);
    expect(mockFetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
  });

  it("replays a staged blob applied before its durable observation and observes every prepared identity", async () => {
    const blobSha = "1".repeat(40);
    let blobExists = false;
    let blobPosts = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/git/blobs/${blobSha}`)) return blobExists ? json({ sha: blobSha }) : json({ message: "Not Found" }, 404);
      if (url.endsWith("/git/blobs") && init?.method === "POST") {
        blobPosts += 1; blobExists = true; return json({ sha: blobSha });
      }
      if (url.endsWith(`/git/trees/${TREE}`)) return json({ sha: TREE, tree: [] });
      if (url.endsWith(`/git/commits/${HEAD}`)) return json({ sha: HEAD, tree: { sha: TREE }, parents: [{ sha: BASE }, { sha: "d".repeat(40) }] });
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const github = adapter(fetchImpl, async () => Buffer.from([0, 255, 7]));
    const prepared = { status: "clean" as const, synthetic: true, headSha: HEAD, treeSha: TREE, candidate: {
      headSha: HEAD, treeSha: TREE, baseTreeSha: "e".repeat(40),
      entries: [{ path: "asset.bin", mode: "100644", type: "blob" as const, sha: blobSha }],
      message: "JARVIS integration generation 1", parents: [BASE, "d".repeat(40)],
      actor: { name: "JARVIS integration controller", email: "jarvis@daniels-project-space.dev", date: "2026-07-21T00:00:00.000Z" },
    } };
    const durable = new Map<string, string | null>();
    const prepare = vi.fn(async (effect: { effectId: string }) => ({ replay: durable.has(effect.effectId), observation: durable.get(effect.effectId) }));
    let fenceBlobOnce = true;
    const observe = vi.fn(async (observation: { effectId: string; observation: string }) => {
      if (observation.effectId.includes("stage-blob") && fenceBlobOnce) { fenceBlobOnce = false; return false; }
      durable.set(observation.effectId, observation.observation); return true;
    });
    await expect(github.stageCandidate(prepared, { prepare, observe })).resolves.toMatchObject({ outcome: "unknown" });
    await expect(github.stageCandidate(prepared, { prepare, observe })).resolves.toMatchObject({ outcome: "applied", providerHeadSha: HEAD });
    expect(blobPosts).toBe(1);
    expect(prepare.mock.calls.filter(([effect]) => effect.effectId.includes("stage-blob"))).toHaveLength(2);
    expect(observe.mock.calls.filter(([observation]) => observation.effectId.includes("stage-blob"))).toHaveLength(2);
    expect([...durable.keys()]).toEqual([
      `stage-blob:attempt-1:${blobSha}`, `stage-tree:attempt-1:${TREE}`, `stage-commit:attempt-1:${HEAD}`,
    ]);
  });

  it("aborts a hung GitHub request at the adapter deadline", async () => {
    const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as unknown as typeof fetch;
    const github = createGitHubIntegrationAdapter({
      repository: "daniels-project-space/jarvis", repositoryNodeId: REPOSITORY_ID,
      remote: "https://github.com/daniels-project-space/jarvis.git", workerBranch: "jarvis/work/x",
      integrationAttemptId: "deadline", createdAt: 1, token: "test", fetchImpl,
      requestTimeoutMs: 5, runGit: vi.fn(async () => ({ code: 0, out: "" })),
    });
    await expect(github.readRef("jarvis/goal/x")).rejects.toThrow("deadline exceeded");
  });

  it("reconcile-only staging records exact absence without creating a new object", async () => {
    const blobSha = "1".repeat(40);
    let posts = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") posts += 1;
      if (url.endsWith(`/git/blobs/${blobSha}`)) return json({ message: "Not Found" }, 404);
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const github = adapter(fetchImpl, async () => Buffer.from("candidate"));
    const prepared = { status: "clean" as const, synthetic: true, headSha: HEAD, treeSha: TREE, candidate: {
      headSha: HEAD, treeSha: TREE, baseTreeSha: BASE,
      entries: [{ path: "candidate.bin", mode: "100644", type: "blob" as const, sha: blobSha }],
      message: "m", parents: [BASE, "d".repeat(40)], actor: { name: "n", email: "e", date: "2026-07-21T00:00:00.000Z" },
    } };
    const observe = vi.fn(async () => true);
    await expect(github.stageCandidate(prepared, {
      reconcileOnly: true, prepare: vi.fn(async () => ({ replay: true, observation: null })), observe,
    })).resolves.toMatchObject({ outcome: "not_applied" });
    expect(posts).toBe(0);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ observation: "not_applied" }));
  });
});
