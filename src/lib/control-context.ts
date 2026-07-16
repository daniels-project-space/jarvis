import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

const adminSession = new AsyncLocalStorage<string | undefined>();

export function withAdminSession<T>(tokenHash: string | undefined, run: () => Promise<T>): Promise<T> {
  return adminSession.run(tokenHash, run);
}

export function currentAdminSession(): string | undefined {
  return adminSession.getStore();
}
