/**
 * Durable jobs carry bounded textual instructions only. Archives, binary
 * inputs and transcripts belong in artifact storage and reach Convex by ref.
 */
export const MAX_TEXT_WORK_ORDER_BYTES = 64 * 1024;

export function textWorkOrderByteLength(task: string): number {
  return new TextEncoder().encode(task).byteLength;
}

/**
 * Validate without normalising or rewriting the task. The returned string is
 * the exact immutable value that policy, durable storage and execution share.
 */
export function exactTextWorkOrder(task: string): string {
  const byteLength = textWorkOrderByteLength(task);
  if (byteLength > MAX_TEXT_WORK_ORDER_BYTES) {
    throw new Error(
      `Text work order exceeds the ${MAX_TEXT_WORK_ORDER_BYTES}-byte UTF-8 limit (received ${byteLength} bytes); store large artifacts outside Convex and pass a bounded textual reference`,
    );
  }
  return task;
}
