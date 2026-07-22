import type { ReactNode } from "react";
import { canRenderPersistentAttachment } from "../lib/guest-attachment";

/**
 * Keep the rendering boundary beside the card renderer, rather than relying on
 * callers to remember that a text-bearing legacy row can also carry a card.
 */
export function GuestSafeAttachment<T>({
  guest,
  attachment,
  renderAttachment,
  children,
}: {
  guest: boolean;
  attachment: T | null | undefined;
  renderAttachment: (attachment: T) => ReactNode;
  children: ReactNode;
}) {
  return canRenderPersistentAttachment(guest, attachment)
    ? <>{renderAttachment(attachment)}</>
    : <>{children}</>;
}
