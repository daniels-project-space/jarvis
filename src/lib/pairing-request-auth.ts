import { timingSafeEqual } from "node:crypto";

export function validPairingRequestBearer(expected: string | undefined, supplied: string): boolean {
  if (!expected || expected.length < 32 || expected.length !== supplied.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}
