export const SUPERVISOR_INPUT_MAX_UTF8_BYTES = 2_000;

export const SUPERVISOR_INPUT_TOO_LARGE_ERROR =
  "Supervisor instructions must be 2,000 UTF-8 bytes or fewer.";

const utf8Encoder = new TextEncoder();

export function supervisorInputUtf8Bytes(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

export function supervisorInputValidationError(
  value: string | undefined,
): string | null {
  if (
    value !== undefined
    && supervisorInputUtf8Bytes(value.trim())
      > SUPERVISOR_INPUT_MAX_UTF8_BYTES
  ) {
    return SUPERVISOR_INPUT_TOO_LARGE_ERROR;
  }
  return null;
}
