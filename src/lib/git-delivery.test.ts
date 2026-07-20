import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureCompleteRepositoryHistory,
  gitDeliveryDisposition,
  isNonFastForwardPush,
  reconcileSharedBranch,
  SHALLOW_PROVENANCE_RULE,
  type GitCommandRunner,
} from "./git-delivery";

const temporaryRoots: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function runGit(cwd: string): GitCommandRunner {
  return async (args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return {
      code: result.status,
      out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
  };
}

function repositoryFixture() {
  const root = mkdtempSync(join(tmpdir(), "jarvis-git-lineage-"));
  temporaryRoots.push(root);
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const branch = "jarvis/shared-repair";
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["init", "--initial-branch", "main", seed], { stdio: "ignore" });
  git(seed, ["config", "user.email", "jarvis@example.invalid"]);
  git(seed, ["config", "user.name", "JARVIS test"]);
  writeFileSync(join(seed, "history.txt"), "root\n");
  git(seed, ["add", "history.txt"]);
  git(seed, ["commit", "-m", "root"]);
  const rootSha = git(seed, ["rev-parse", "HEAD"]);
  writeFileSync(join(seed, "history.txt"), "root\nshared branch\n");
  git(seed, ["add", "history.txt"]);
  git(seed, ["commit", "-m", "shared branch checkpoint"]);
  const sharedSha = git(seed, ["rev-parse", "HEAD"]);
  git(seed, ["push", `file://${remote}`, `HEAD:refs/heads/${branch}`]);
  return { root, remote, remoteUrl: `file://${remote}`, branch, rootSha, sharedSha };
}

function cloneShallow(remoteUrl: string, branch: string, destination: string) {
  execFileSync(
    "git",
    ["clone", "--depth", "1", "--single-branch", "--branch", branch, remoteUrl, destination],
    { stdio: "ignore" },
  );
  git(destination, ["config", "user.email", "jarvis@example.invalid"]);
  git(destination, ["config", "user.name", "JARVIS test"]);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable Git delivery", () => {
  it("does not overwrite a shared branch that advanced while a no-op worker ran", () => {
    expect(gitDeliveryDisposition({ baseSha: "base", localSha: "base", remoteSha: "new-remote" }))
      .toBe("noop");
  });

  it("pushes a local commit only when the remote still matches its starting point", () => {
    expect(gitDeliveryDisposition({ baseSha: "base", localSha: "local", remoteSha: "base" }))
      .toBe("push");
    expect(gitDeliveryDisposition({ baseSha: "base", localSha: "local" })).toBe("push");
  });

  it("reconciles divergent local and remote progress before delivery", () => {
    expect(gitDeliveryDisposition({ baseSha: "base", localSha: "local", remoteSha: "remote" }))
      .toBe("reconcile");
    expect(isNonFastForwardPush("! [rejected] HEAD -> branch (non-fast-forward)"))
      .toBe(true);
  });

  it("hydrates a parent hidden by the shallow boundary before judging provenance", async () => {
    const fixture = repositoryFixture();
    const worker = join(fixture.root, "worker");
    cloneShallow(fixture.remoteUrl, fixture.branch, worker);

    expect(git(worker, ["rev-parse", "--is-shallow-repository"])).toBe("true");
    expect(git(worker, ["cat-file", "-p", "HEAD"])).toContain(`parent ${fixture.rootSha}`);
    expect(git(worker, ["rev-list", "--parents", "-n", "1", "HEAD"])).toBe(fixture.sharedSha);

    const readiness = await ensureCompleteRepositoryHistory({
      runGit: runGit(worker),
      remote: fixture.remoteUrl,
      sourceBranch: fixture.branch,
    });

    expect(readiness).toMatchObject({ ok: true, hydrated: true });
    expect(git(worker, ["rev-parse", "--is-shallow-repository"])).toBe("false");
    expect(git(worker, ["rev-list", "--parents", "-n", "1", "HEAD"])).toBe(
      `${fixture.sharedSha} ${fixture.rootSha}`,
    );
    expect(SHALLOW_PROVENANCE_RULE).toBe("Shallow history is not evidence of parentless provenance.");
  });

  it("continues a concurrently advanced shared branch with a verified fast-forward", async () => {
    const fixture = repositoryFixture();
    const worker = join(fixture.root, "worker");
    const concurrent = join(fixture.root, "concurrent");
    cloneShallow(fixture.remoteUrl, fixture.branch, worker);
    await ensureCompleteRepositoryHistory({
      runGit: runGit(worker),
      remote: fixture.remoteUrl,
      sourceBranch: fixture.branch,
    });

    writeFileSync(join(worker, "worker.txt"), "worker repair retained\n");
    git(worker, ["add", "worker.txt"]);
    git(worker, ["commit", "-m", "worker repair"]);
    const originalWorkerSha = git(worker, ["rev-parse", "HEAD"]);

    execFileSync(
      "git",
      ["clone", "--single-branch", "--branch", fixture.branch, fixture.remoteUrl, concurrent],
      { stdio: "ignore" },
    );
    git(concurrent, ["config", "user.email", "jarvis@example.invalid"]);
    git(concurrent, ["config", "user.name", "JARVIS test"]);
    writeFileSync(join(concurrent, "concurrent.txt"), "canonical concurrent checkpoint\n");
    git(concurrent, ["add", "concurrent.txt"]);
    git(concurrent, ["commit", "-m", "concurrent checkpoint"]);
    const concurrentSha = git(concurrent, ["rev-parse", "HEAD"]);
    git(concurrent, ["push", fixture.remoteUrl, `HEAD:refs/heads/${fixture.branch}`]);

    const reconciliation = await reconcileSharedBranch({
      runGit: runGit(worker),
      remote: fixture.remoteUrl,
      branch: fixture.branch,
      historySourceBranch: fixture.branch,
      baseSha: fixture.sharedSha,
      localSha: originalWorkerSha,
    });

    expect(reconciliation).toMatchObject({ status: "ready", rebased: true });
    expect(reconciliation.localSha).not.toBe(originalWorkerSha);
    expect(git(worker, ["rev-parse", "HEAD^"])).toBe(concurrentSha);
    git(worker, ["push", fixture.remoteUrl, `HEAD:refs/heads/${fixture.branch}`]);

    const delivered = git(fixture.remote, ["rev-parse", `refs/heads/${fixture.branch}`]);
    expect(delivered).toBe(reconciliation.localSha);
    expect(git(fixture.remote, ["merge-base", "--is-ancestor", fixture.sharedSha, delivered])).toBe("");
    expect(git(fixture.remote, ["merge-base", "--is-ancestor", concurrentSha, delivered])).toBe("");
    expect(git(fixture.remote, ["show", `${delivered}:worker.txt`])).toBe("worker repair retained");
    expect(git(fixture.remote, ["show", `${delivered}:concurrent.txt`])).toBe("canonical concurrent checkpoint");
  });

  it("rejects replacement history instead of rewriting a valid shared branch", async () => {
    const fixture = repositoryFixture();
    const worker = join(fixture.root, "worker");
    cloneShallow(fixture.remoteUrl, fixture.branch, worker);
    git(worker, ["checkout", "--orphan", "replacement"]);
    git(worker, ["rm", "-rf", "."]);
    writeFileSync(join(worker, "replacement.txt"), "manufactured root\n");
    git(worker, ["add", "replacement.txt"]);
    git(worker, ["commit", "-m", "manufactured replacement"]);
    const replacementSha = git(worker, ["rev-parse", "HEAD"]);

    const reconciliation = await reconcileSharedBranch({
      runGit: runGit(worker),
      remote: fixture.remoteUrl,
      branch: fixture.branch,
      historySourceBranch: fixture.branch,
      baseSha: fixture.sharedSha,
      localSha: replacementSha,
    });

    expect(reconciliation).toMatchObject({ status: "retry", rebased: false });
    expect(reconciliation.note).toContain("no longer descends from canonical base");
    expect(git(fixture.remote, ["rev-parse", `refs/heads/${fixture.branch}`])).toBe(fixture.sharedSha);
  });
});
