export class ClientDeadlineError extends Error {
  constructor(label: string) {
    super(`${label} timed out`);
    this.name = "ClientDeadlineError";
  }
}

export function withClientDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => finish(() => reject(new ClientDeadlineError(label))), timeoutMs);
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}
