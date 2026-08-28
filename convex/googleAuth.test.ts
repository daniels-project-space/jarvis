import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}

const modules = import.meta.glob("./**/*.ts");
const WORKER = "google-auth-test-worker";
const OWNER = "a".repeat(64);

beforeEach(() => {
  process.env.JARVIS_WORKER_TOKEN = WORKER;
});

afterEach(() => {
  delete process.env.JARVIS_WORKER_TOKEN;
});

async function ownerSession(t: ReturnType<typeof convexTest>) {
  await t.mutation(api.controlAuth.createOpenSession, {
    ownerTokenHash: OWNER,
    workerToken: WORKER,
  });
}

describe("Google OAuth connection capability boundary", () => {
  it("rejects unauthenticated reads and connection replacement", async () => {
    const t = convexTest(schema, modules);

    await expect(t.query(api.googleAuth.getConnectionStatus, {})).rejects.toThrow(/Authentication required/i);
    await expect(t.query(api.googleAuth.getEncryptedConnection, {})).rejects.toThrow(/Unauthorized worker capability/i);
    await expect(t.mutation(api.googleAuth.upsertConnection, {
      encryptedRefreshToken: "ciphertext",
      scope: "scope",
    })).rejects.toThrow(/Authentication required/i);
  });

  it("keeps credential envelope server/worker-only while allowing authenticated status", async () => {
    const t = convexTest(schema, modules);
    await ownerSession(t);
    await t.mutation(api.googleAuth.upsertConnection, {
      encryptedRefreshToken: "ciphertext",
      scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
      email: "daniel@example.com",
      authTokenHash: OWNER,
    });

    await expect(t.query(api.googleAuth.getConnectionStatus, {
      workerToken: WORKER,
    })).resolves.toMatchObject({
      connected: true,
      email: "daniel@example.com",
      capabilities: { gmail: true },
    });
    await t.mutation(api.googleAuth.upsertConnection, {
      encryptedRefreshToken: "ciphertext-v2",
      scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
      email: "daniel@example.com",
      authTokenHash: OWNER,
    });
    await expect(t.query(api.googleAuth.getConnectionStatus, {
      workerToken: WORKER,
    })).resolves.toMatchObject({
      capabilities: { gmail: true },
    });
    await expect(t.query(api.googleAuth.getEncryptedConnection, {
      workerToken: "wrong-worker-token",
    })).rejects.toThrow(/Unauthorized worker capability/i);
    await expect(t.query(api.googleAuth.getEncryptedConnection, {
      workerToken: WORKER,
    })).resolves.toEqual({
      encryptedRefreshToken: "ciphertext-v2",
      scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
    });
  });
});
