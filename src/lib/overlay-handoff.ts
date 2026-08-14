/** A delegated task may close only its originating embedded overlay. */
export function shouldDismissEmbeddedHandoff(args: {
  embedded: boolean;
  awaitingApproval: boolean;
}): boolean {
  return args.embedded && !args.awaitingApproval;
}
