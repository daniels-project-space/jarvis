import { v } from "convex/values";
import {
  projectSourceAdmissionIsValid,
  type ProjectSourceAdmission,
} from "../src/lib/source-admission";

export const projectSourceAdmissionValidator = v.object({
  protocolVersion: v.literal(2),
  canonicalProjectId: v.string(),
  repository: v.optional(v.string()),
  sourceProvider: v.union(v.literal("github"), v.literal("none")),
  sourceBranch: v.optional(v.string()),
  sourceRef: v.optional(v.string()),
  sourceHeadSha: v.optional(v.string()),
  sourceObservedAt: v.number(),
  sourceAdmissionDigest: v.string(),
});

export async function validProjectAdmissions(
  admissions: readonly ProjectSourceAdmission[],
  options: { requireFresh?: boolean } = {},
): Promise<boolean> {
  if (!admissions.length || admissions.length > 16) return false;
  const scopes = new Set<string>();
  for (const admission of admissions) {
    if (!await projectSourceAdmissionIsValid(admission, {
      expectedRepository: admission.repository,
      requireFresh: options.requireFresh,
    })) return false;
    const scope = admission.repository ?? "evidence";
    if (scopes.has(scope)) return false;
    scopes.add(scope);
  }
  return true;
}

export function admissionForRepository(
  admissions: readonly ProjectSourceAdmission[] | undefined,
  repository?: string,
): ProjectSourceAdmission | null {
  return admissions?.find((admission) => admission.repository === repository)
    ?? (!repository ? admissions?.find((admission) => !admission.repository) : undefined)
    ?? null;
}
