// Fixture-only: compact-work deliberately stays on the durable path, but
// esbuild would otherwise follow the realtime package's Node-only transport.
export function useRealtimeRun(..._args: unknown[]) {
  return { run: null, error: null };
}
