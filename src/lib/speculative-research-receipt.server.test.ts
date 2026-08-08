import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  issueSpeculativeResearchReceipt,
  promoteSpeculativeResearchReceipt,
} from "./speculative-research-receipt.server";

const ORIGINAL_RECEIPT_SECRET = process.env.JARVIS_SPECULATIVE_RESEARCH_RECEIPT_SECRET;
const ORIGINAL_DISPATCH_TOKEN = process.env.JARVIS_DISPATCH_TOKEN;
const OWNER_HASH = "a".repeat(64);
const BASIS = "Look into how Sesame is training its conversational voice agents";
const NOW = 1_900_000_000_000;

describe("speculative research receipt authority", () => {
  beforeEach(() => {
    process.env.JARVIS_SPECULATIVE_RESEARCH_RECEIPT_SECRET = "receipt-secret:" + "x".repeat(48);
    delete process.env.JARVIS_DISPATCH_TOKEN;
  });

  afterAll(() => {
    if (ORIGINAL_RECEIPT_SECRET === undefined) delete process.env.JARVIS_SPECULATIVE_RESEARCH_RECEIPT_SECRET;
    else process.env.JARVIS_SPECULATIVE_RESEARCH_RECEIPT_SECRET = ORIGINAL_RECEIPT_SECRET;
    if (ORIGINAL_DISPATCH_TOKEN === undefined) delete process.env.JARVIS_DISPATCH_TOKEN;
    else process.env.JARVIS_DISPATCH_TOKEN = ORIGINAL_DISPATCH_TOKEN;
  });

  function issue() {
    return issueSpeculativeResearchReceipt({
      actorAuthHash: OWNER_HASH,
      threadId: "main",
      requestId: "voice:utterance-1",
      basis: BASIS,
      sources: [
        { title: "Sesame research", url: "https://example.com/sesame", snippet: "External research about conversational voice agents." },
      ],
      now: NOW,
    });
  }

  it("issues a 45-second opaque receipt and promotes it to a bounded untrusted sidecar", () => {
    const issued = issue();
    expect(issued.expiresAt).toBe(NOW + 45_000);
    expect(issued.receipt).toMatch(/^sr1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    expect(issued.receipt).not.toContain(OWNER_HASH);
    const sidecar = promoteSpeculativeResearchReceipt(
      issued.receipt,
      OWNER_HASH,
      "main",
      "voice:utterance-1",
      `${BASIS} and identify useful quality-of-life improvements for Jarvis`,
      NOW + 1_000,
    );
    expect(sidecar).toMatchObject({ basis: BASIS, expiresAt: NOW + 45_000 });
    expect(sidecar?.context).toContain("UNTRUSTED WEB RESEARCH PREFETCH");
    expect(sidecar?.context).toContain("https://example.com/sesame");
  });

  it("fails closed on tampering, stale turns, identity changes, and correction suffixes", () => {
    const issued = issue();
    const replacement = issued.receipt.endsWith("0") ? "1" : "0";
    const tampered = issued.receipt.slice(0, -1) + replacement;
    const finalText = `${BASIS} and compare the findings with Jarvis`;
    expect(promoteSpeculativeResearchReceipt(tampered, OWNER_HASH, "main", "voice:utterance-1", finalText, NOW + 1)).toBeNull();
    expect(promoteSpeculativeResearchReceipt(issued.receipt, "b".repeat(64), "main", "voice:utterance-1", finalText, NOW + 1)).toBeNull();
    expect(promoteSpeculativeResearchReceipt(issued.receipt, OWNER_HASH, "other", "voice:utterance-1", finalText, NOW + 1)).toBeNull();
    expect(promoteSpeculativeResearchReceipt(issued.receipt, OWNER_HASH, "main", "voice:other", finalText, NOW + 1)).toBeNull();
    expect(promoteSpeculativeResearchReceipt(issued.receipt, OWNER_HASH, "main", "voice:utterance-1", `${BASIS}, actually instead research flights`, NOW + 1)).toBeNull();
    expect(promoteSpeculativeResearchReceipt(issued.receipt, OWNER_HASH, "main", "voice:utterance-1", finalText, NOW + 45_000)).toBeNull();
  });

  it("requires a dedicated or existing high-entropy server authority", () => {
    delete process.env.JARVIS_SPECULATIVE_RESEARCH_RECEIPT_SECRET;
    delete process.env.JARVIS_DISPATCH_TOKEN;
    expect(() => issue()).toThrow(/authority is not configured/);
  });
});
