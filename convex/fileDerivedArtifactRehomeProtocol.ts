import { ConvexError } from "convex/values";

export const FILE_DERIVED_ARTIFACT_REHOME_CONTROL_KEY = "file-derived-artifact-rehome-v1-to-v2";
export const FILE_DERIVED_ARTIFACT_REHOME_LEASE_MS = 10 * 60_000;
export const FILE_DERIVED_ARTIFACT_REHOME_RETRY_AFTER_MS = 60_000;
export const INGEST_OUTPUT_PROTOCOL_V1 = 1;
export const INGEST_OUTPUT_PROTOCOL_V2 = 2;

export type DerivedArtifactKeys = {
  extractedTextR2Key: string;
  previewR2Key: string;
};

export function canonicalDerivedArtifactKeys(
  fileId: unknown,
  ingestVersion: number,
  outputProtocol: number,
  outputAttemptId?: string,
): DerivedArtifactKeys {
  const id = String(fileId).trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || !Number.isSafeInteger(ingestVersion) || ingestVersion < 1) {
    throw new ConvexError({ code: "FILE_DERIVED_REHOME_KEY", message: "Derived artifact identity is invalid" });
  }
  if (outputProtocol === INGEST_OUTPUT_PROTOCOL_V1) {
    return {
      extractedTextR2Key: `owners/daniel/files/${id}/v${ingestVersion}/extracted.txt`,
      previewR2Key: `owners/daniel/files/${id}/v${ingestVersion}/preview.webp`,
    };
  }
  const attempt = String(outputAttemptId ?? "").trim();
  if (outputProtocol !== INGEST_OUTPUT_PROTOCOL_V2 || !/^[a-zA-Z0-9_-]{16,180}$/.test(attempt)) {
    throw new ConvexError({ code: "FILE_DERIVED_REHOME_KEY", message: "Derived artifact target identity is invalid" });
  }
  return {
    extractedTextR2Key: `owners/daniel/files/${id}/v${ingestVersion}/a${attempt}/extracted.txt`,
    previewR2Key: `owners/daniel/files/${id}/v${ingestVersion}/a${attempt}/preview.webp`,
  };
}

export function rehomeOutputAttemptId(rehomeId: unknown, generation: number): string {
  const id = String(rehomeId).trim();
  if (!/^[a-zA-Z0-9_-]{8,160}$/.test(id) || !Number.isSafeInteger(generation) || generation < 1 || generation > 10_000) {
    throw new ConvexError({ code: "FILE_DERIVED_REHOME_ATTEMPT", message: "Derived artifact rehome attempt is invalid" });
  }
  const attempt = `rehome-${id}-g${generation}`;
  if (!/^[a-zA-Z0-9_-]{16,180}$/.test(attempt)) {
    throw new ConvexError({ code: "FILE_DERIVED_REHOME_ATTEMPT", message: "Derived artifact rehome attempt is invalid" });
  }
  return attempt;
}

export async function fileDerivedArtifactRehomeControl(ctx: { db: any }) {
  return await ctx.db
    .query("fileDerivedArtifactRehomeControls")
    .withIndex("by_key", (q: any) => q.eq("key", FILE_DERIVED_ARTIFACT_REHOME_CONTROL_KEY))
    .first();
}

export function rehomeBlocksNormalFileMutation(control: any | null | undefined): boolean {
  return Boolean(control && control.phase !== "active");
}
