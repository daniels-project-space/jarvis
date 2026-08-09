import { createHash, randomBytes } from "node:crypto";

async function main(): Promise<void> {
  const convexUrl = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL;
  const workerToken = process.env.JARVIS_WORKER_TOKEN;
  const publicUrl = (process.env.JARVIS_PUBLIC_URL ?? "https://jarvis-orcin-six.vercel.app").replace(/\/$/, "");

  if (!convexUrl || !workerToken) throw new Error("Jarvis production pairing environment is incomplete");

  const ticket = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(ticket).digest("hex");
  // Single-use still prevents replay, while a full day avoids Daniel finding a
  // freshly issued link expired by the time he returns to the owner browser.
  const expiresAt = Date.now() + 24 * 60 * 60_000;
  const response = await fetch(`${convexUrl}/api/mutation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: "controlAuth:createOwnerPairingTicket",
      args: { tokenHash, expiresAt, workerToken },
      format: "json",
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.status === "error" || payload?.value?.expiresAt !== expiresAt) {
    throw new Error("Jarvis rejected the pairing ticket");
  }

  // The fragment is never sent in the HTTP request. /pair consumes it from the
  // browser and POSTs it once; Convex stores only the hash.
  process.stdout.write(`${publicUrl}/pair#${ticket}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Jarvis pairing failed"}\n`);
  process.exitCode = 1;
});
