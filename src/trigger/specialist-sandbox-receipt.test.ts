import {
  constants as fsConstants,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const receiptFs = vi.hoisted(() => ({
  closeSync: vi.fn(),
  fstatSync: vi.fn(),
  openSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, ...receiptFs };
});

import { readNamespaceProbeReceipt } from "./specialist-sandbox";

const roots: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("specialist namespace receipt descriptor boundary", () => {
  it("opens no-follow and validates, reads, revalidates, and closes that same FD", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-receipt-fd-test-"));
    roots.push(root);
    const bytes = '{"receipt":"controller-opened"}';
    const fixture = join(root, "fixture.json");
    writeFileSync(fixture, bytes, { mode: 0o600 });
    const stat = statSync(fixture);
    const syntheticFd = 917;
    const vanishedPath = join(root, "path-does-not-exist.json");
    receiptFs.openSync.mockReturnValue(syntheticFd);
    receiptFs.fstatSync.mockReturnValue(stat);
    receiptFs.readFileSync.mockReturnValue(bytes);

    expect(readNamespaceProbeReceipt(vanishedPath, {
      device: stat.dev,
      inode: stat.ino,
    })).toBe(bytes);

    expect(receiptFs.openSync).toHaveBeenCalledWith(
      vanishedPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    expect(receiptFs.fstatSync).toHaveBeenNthCalledWith(1, syntheticFd);
    expect(receiptFs.readFileSync).toHaveBeenCalledWith(syntheticFd, "utf8");
    expect(receiptFs.fstatSync).toHaveBeenNthCalledWith(2, syntheticFd);
    expect(receiptFs.closeSync).toHaveBeenCalledWith(syntheticFd);

    receiptFs.readFileSync.mockClear();
    receiptFs.closeSync.mockClear();
    expect(() => readNamespaceProbeReceipt(vanishedPath, {
      device: stat.dev,
      inode: stat.ino + 1,
    })).toThrow("identity changed");
    expect(receiptFs.readFileSync).not.toHaveBeenCalled();
    expect(receiptFs.closeSync).toHaveBeenCalledWith(syntheticFd);
  });
});
