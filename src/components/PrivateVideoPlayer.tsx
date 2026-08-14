"use client";

export function PrivateVideoPlayer({ url, title }: { url: string; title?: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-black">
      <video
        aria-label={title ? `Private video: ${title}` : "Private video"}
        className="h-full min-h-0 w-full max-w-full flex-1 object-contain"
        controls
        playsInline
        preload="metadata"
        src={url}
      />
    </div>
  );
}
