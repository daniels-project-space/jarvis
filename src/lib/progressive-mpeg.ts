/**
 * MP3 can be appended to a MediaSource in Chromium, but the capability is not
 * universal. Keep the decision in one tiny, testable boundary so callers can
 * retain a fully-buffered Web Audio fallback everywhere else.
 */
export function supportsProgressiveMpegPlayback(): boolean {
  if (typeof window === "undefined" || typeof MediaSource === "undefined" || typeof Audio === "undefined") {
    return false;
  }
  return MediaSource.isTypeSupported("audio/mpeg");
}
