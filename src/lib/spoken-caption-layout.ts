export const SPOKEN_CAPTION_TEXT_CLASS = "text-[0.95rem] font-semibold leading-snug tracking-tight md:text-[1.3rem] lg:text-[1.5rem]";

export function spokenCaptionStageClassName({
  compactAside,
  commandExpanded,
  overlayUp,
}: {
  compactAside: boolean;
  commandExpanded: boolean;
  overlayUp: boolean;
}): string {
  return compactAside || (commandExpanded && !overlayUp)
    ? "top-[74%] hidden md:flex md:left-[62%] md:right-0"
    : "top-[63%] inset-x-0";
}

export function spokenCaptionSurfaceClassName({
  fullBleed,
  compactAside,
  commandExpanded,
  overlayUp,
}: {
  fullBleed: boolean;
  compactAside: boolean;
  commandExpanded: boolean;
  overlayUp: boolean;
}): string {
  return fullBleed
    ? "fixed bottom-[4.75rem] inset-x-0 px-4"
    : `absolute ${spokenCaptionStageClassName({ compactAside, commandExpanded, overlayUp })} px-6`;
}
