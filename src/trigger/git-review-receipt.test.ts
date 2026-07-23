import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildGitReviewReceipt,
  commandEvidenceFromCodexEvent,
  createGitReviewReceiptAuthority,
  type GitCommandEvidence,
} from "./git-review-receipt";
import type { GitCommandRunner } from "../lib/git-delivery";

const roots: string[] = [];
const startingDirectory = process.cwd();
const WORK_ORDER_REVISION_DIGEST = createHash("sha256")
  .update("canonical test work-order revision: controller Git review")
  .digest("hex");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function runGit(cwd: string): GitCommandRunner {
  return async (args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  };
}

function repositoryFixture(label = "review") {
  const root = mkdtempSync(join(tmpdir(), `jarvis-${label}-receipt-`));
  roots.push(root);
  const checkout = join(root, "checkout");
  const unrelatedDirectory = join(root, "unrelated-current-working-directory");
  mkdirSync(unrelatedDirectory);
  execFileSync("git", ["init", "--initial-branch", "main", checkout], { stdio: "ignore" });
  git(checkout, ["config", "user.email", "jarvis@example.invalid"]);
  git(checkout, ["config", "user.name", "JARVIS test"]);
  writeFileSync(join(checkout, "proof.txt"), "base\n");
  git(checkout, ["add", "proof.txt"]);
  git(checkout, ["commit", "-m", "base"]);
  const baseSha = git(checkout, ["rev-parse", "HEAD"]);
  writeFileSync(join(checkout, "proof.txt"), `base\n${label} change\n`);
  git(checkout, ["add", "proof.txt"]);
  git(checkout, ["commit", "-m", `${label} change`]);
  const headSha = git(checkout, ["rev-parse", "HEAD"]);
  return { root, checkout, unrelatedDirectory, baseSha, headSha };
}

afterEach(() => {
  process.chdir(startingDirectory);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("controller Git review receipts", () => {
  it("verifies the exact hydrated checkout despite an unrelated caller working directory", async () => {
    const fixture = repositoryFixture();
    const command = commandEvidenceFromCodexEvent({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "npm test",
        exit_code: 0,
        status: "completed",
        aggregated_output: "12 tests passed; AUTH_TOKEN=controller-secret-value",
      },
    }, { AUTH_TOKEN: "controller-secret-value" });
    expect(command).not.toBeNull();
    process.chdir(fixture.unrelatedDirectory);
    expect(process.cwd()).not.toBe(fixture.checkout);

    const built = await buildGitReviewReceipt({
      runGit: runGit(fixture.checkout),
      jobId: "job-exact",
      attempt: 2,
      workOrderRevisionDigest: WORK_ORDER_REVISION_DIGEST,
      repository: "daniels-project-space/jarvis",
      expectedBranch: "main",
      baseSha: fixture.baseSha,
      expectedHeadSha: fixture.headSha,
      agentEvidence: "Implemented the requested repair and ran npm test.",
      commands: [command!],
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.receipt).toMatchObject({
      jobId: "job-exact",
      attempt: 2,
      repository: "daniels-project-space/jarvis",
      branch: "main",
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      parentShas: [fixture.baseSha],
      historyComplete: true,
      baseIsAncestor: true,
      commitCount: 1,
      clean: true,
    });
    expect(built.receipt.diffPatch).toContain("+review change");
    expect(built.receipt.changedPaths).toContain("proof.txt");
    expect(built.receipt.commands[0]).toMatchObject({ command: "npm test", exitCode: 0 });
    expect(built.receipt.commands[0].output).not.toContain("controller-secret-value");

    const authority = createGitReviewReceiptAuthority(Buffer.alloc(32, 7));
    const envelope = authority.issue(built.receipt);
    expect(authority.verify(envelope, built.binding)).toBe(true);
    const rendered = authority.render(envelope, built.binding);
    expect(rendered).toContain("controller-hmac-sha256-verified");
    expect(rendered).toContain(fixture.headSha);
    expect(rendered).not.toContain(fixture.checkout);
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.receipt)).toBe(true);
  });

  it("rejects mutation and cross-job receipt substitution", async () => {
    const first = repositoryFixture("first");
    const second = repositoryFixture("second");
    const input = (fixture: typeof first, jobId: string) => ({
      runGit: runGit(fixture.checkout),
      jobId,
      attempt: 1,
      workOrderRevisionDigest: WORK_ORDER_REVISION_DIGEST,
      repository: "daniels-project-space/jarvis",
      expectedBranch: "main",
      baseSha: fixture.baseSha,
      expectedHeadSha: fixture.headSha,
      agentEvidence: `${jobId} evidence`,
      commands: [] as GitCommandEvidence[],
    });
    const [firstBuilt, secondBuilt] = await Promise.all([
      buildGitReviewReceipt(input(first, "job-first")),
      buildGitReviewReceipt(input(second, "job-second")),
    ]);
    expect(firstBuilt.ok && secondBuilt.ok).toBe(true);
    if (!firstBuilt.ok || !secondBuilt.ok) return;

    const authority = createGitReviewReceiptAuthority(Buffer.alloc(32, 9));
    const firstEnvelope = authority.issue(firstBuilt.receipt);
    const secondEnvelope = authority.issue(secondBuilt.receipt);
    expect(authority.verify(secondEnvelope, firstBuilt.binding)).toBe(false);

    const tampered = JSON.parse(JSON.stringify(firstEnvelope));
    tampered.receipt.headSha = second.headSha;
    tampered.receipt.diffPatch = "substituted diff";
    expect(authority.verify(tampered, firstBuilt.binding)).toBe(false);
    expect(authority.verify(firstEnvelope, firstBuilt.binding)).toBe(true);
  });

  it("detects a checkout mutation instead of reviewing a moving worktree", async () => {
    const fixture = repositoryFixture("clean");
    writeFileSync(join(fixture.checkout, "after-receipt.txt"), "uncommitted substitution\n");

    await expect(buildGitReviewReceipt({
      runGit: runGit(fixture.checkout),
      jobId: "job-dirty",
      attempt: 1,
      workOrderRevisionDigest: WORK_ORDER_REVISION_DIGEST,
      repository: "daniels-project-space/jarvis",
      expectedBranch: "main",
      baseSha: fixture.baseSha,
      expectedHeadSha: fixture.headSha,
      agentEvidence: "evidence",
    })).resolves.toEqual({
      ok: false,
      note: "review checkout contains uncommitted or untracked changes",
    });
  });

  it("never treats a shallow boundary as evidence that HEAD is parentless", async () => {
    const fixture = repositoryFixture("shallow");
    const remote = join(fixture.root, "remote.git");
    const shallow = join(fixture.root, "shallow");
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    git(fixture.checkout, ["push", `file://${remote}`, "HEAD:refs/heads/main"]);
    execFileSync(
      "git",
      ["clone", "--depth", "1", "--single-branch", "--branch", "main", `file://${remote}`, shallow],
      { stdio: "ignore" },
    );
    expect(git(shallow, ["rev-parse", "--is-shallow-repository"])).toBe("true");
    expect(git(shallow, ["rev-list", "--parents", "-n", "1", "HEAD"])).toBe(fixture.headSha);

    const built = await buildGitReviewReceipt({
      runGit: runGit(shallow),
      jobId: "job-shallow",
      attempt: 1,
      workOrderRevisionDigest: WORK_ORDER_REVISION_DIGEST,
      repository: "daniels-project-space/jarvis",
      expectedBranch: "main",
      baseSha: fixture.headSha,
      expectedHeadSha: fixture.headSha,
      agentEvidence: "evidence",
    });
    expect(built).toEqual({
      ok: false,
      note: "review checkout history is shallow; parent and ancestry claims are unverifiable",
    });
  });

  it("reviews the cumulative two-attempt lineage from the immutable first source head", async () => {
    const fixture = repositoryFixture("attempt-one");
    writeFileSync(join(fixture.checkout, "attempt-two.txt"), "second checkpoint\n");
    git(fixture.checkout, ["add", "attempt-two.txt"]);
    git(fixture.checkout, ["commit", "-m", "attempt two change"]);
    const finalHead = git(fixture.checkout, ["rev-parse", "HEAD"]);
    const finalTree = git(fixture.checkout, ["rev-parse", "HEAD^{tree}"]);

    const built = await buildGitReviewReceipt({
      runGit: runGit(fixture.checkout), jobId: "job-two-attempt", attempt: 2,
      workOrderRevisionDigest: WORK_ORDER_REVISION_DIGEST,
      repository: "daniels-project-space/jarvis", expectedBranch: "main",
      baseSha: fixture.baseSha, expectedHeadSha: finalHead,
      agentEvidence: "attempt one checkpoint plus attempt two completion",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.receipt).toMatchObject({
      baseSha: fixture.baseSha, headSha: finalHead, headTreeSha: finalTree, commitCount: 2,
    });
    expect(built.receipt.commits).toContain("attempt-one change");
    expect(built.receipt.commits).toContain("attempt two change");
    expect(built.receipt.diffPatch).toContain("+attempt-one change");
    expect(built.receipt.diffPatch).toContain("+second checkpoint");

    git(fixture.checkout, ["checkout", "-b", "moved-source", fixture.baseSha]);
    writeFileSync(join(fixture.checkout, "forged.txt"), "moved source\n");
    git(fixture.checkout, ["add", "forged.txt"]);
    git(fixture.checkout, ["commit", "-m", "moved source"]);
    const movedSource = git(fixture.checkout, ["rev-parse", "HEAD"]);
    git(fixture.checkout, ["checkout", "main"]);
    await expect(buildGitReviewReceipt({
      runGit: runGit(fixture.checkout), jobId: "job-two-attempt", attempt: 2,
      workOrderRevisionDigest: WORK_ORDER_REVISION_DIGEST,
      repository: "daniels-project-space/jarvis", expectedBranch: "main",
      baseSha: movedSource, expectedHeadSha: finalHead, agentEvidence: "forged source",
    })).resolves.toEqual({ ok: false, note: "review checkout head does not descend from its prepared base" });
  });
});
