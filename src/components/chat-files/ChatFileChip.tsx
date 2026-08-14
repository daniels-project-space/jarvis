import type { ChatFileManifest } from "@/lib/chat-files";

export function ChatFileChip({
  file,
  onRemove,
}: {
  file: ChatFileManifest;
  onRemove?: () => void;
}) {
  const indexed = file.status === "ready";
  const storedOnly = file.status === "stored_only";
  return (
    <span className="inline-flex max-w-56 items-center gap-2 rounded-full border border-cyan/25 bg-cyan/8 px-3 py-1.5 text-xs text-slate-100">
      <span aria-hidden="true">{file.mimeType.startsWith("image/") ? "▧" : "▤"}</span>
      <span className="min-w-0 truncate" title={file.relativePath || file.name}>{file.name}</span>
      {storedOnly && <span className="shrink-0 text-[10px] text-slate-400">saved only</span>}
      {!indexed && !storedOnly && <span className="shrink-0 text-[10px] text-amber-300">{file.status === "error" ? "failed" : "processing"}</span>}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${file.name}`}
          className="-mr-1 grid size-5 shrink-0 place-items-center rounded-full text-slate-400 hover:bg-white/10 hover:text-white"
        >
          ×
        </button>
      )}
    </span>
  );
}
