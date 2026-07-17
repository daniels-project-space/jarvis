"use client";

export async function clientMutation<T = unknown>(path: string, args: Record<string, unknown>): Promise<T> {
  const response = await fetch("/api/client-mutation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args }),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok !== true) throw new Error("Private state update was rejected");
  return payload.value as T;
}
