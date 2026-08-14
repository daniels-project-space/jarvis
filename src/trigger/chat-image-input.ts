import sharp from "sharp";
import {
  isImageMime,
  serializeUntrustedFileValue,
  type ChatFileManifest,
} from "../lib/chat-files";
import { readBoundedResponseBytes } from "../lib/bounded-json";
import {
  CODEX_IMAGE_LIMITS,
  boundedCodexImageInputs,
  trustedCaptureId,
  trustedCaptureUrl,
  type CodexImageInput,
} from "../lib/codex-image-data";
import { privateCaptureObjectKey, privateR2Get } from "../lib/private-r2";

type ImageAttachment = ChatFileManifest & { r2Key: string };
type ImageInputDependencies = {
  getPrivate: (key: string, signal: AbortSignal) => Promise<Response>;
  fetchCapture: (url: URL, signal: AbortSignal) => Promise<Response>;
};
type ImageInputOptions = Partial<ImageInputDependencies> & { signal?: AbortSignal };
type ImageSource = {
  label: string;
  maximumBytes: number;
  read: (signal: AbortSignal) => Promise<Response>;
};

const defaultDependencies: ImageInputDependencies = {
  getPrivate: async (key, signal) => await privateR2Get(key, undefined, signal),
  fetchCapture: async (url, signal) => await fetch(url, {
    headers: { accept: "image/avif,image/webp,image/png,image/jpeg" },
    redirect: "error",
    signal,
  }),
};

function abortError(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback);
}

async function withImageReadDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  if (parentSignal?.aborted) throw abortError(parentSignal, "image read cancelled");
  if (timeoutMs <= 0) throw new Error("image read timed out");
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("image read timed out")),
    timeoutMs,
  );
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(abortError(controller.signal, "image read cancelled")),
      { once: true },
    );
  });
  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

async function responseImageBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`image read failed (${response.status})`);
  const bytes = await readBoundedResponseBytes(response, maximumBytes);
  if (!bytes.byteLength) throw new Error("image response was empty");
  return bytes;
}

export async function codexInlineImageFromBytes(
  bytes: Uint8Array,
  maximumDataUrlBytes = CODEX_IMAGE_LIMITS.maxDataUrlBytesPerImage,
): Promise<string> {
  if (!bytes.byteLength || bytes.byteLength > CODEX_IMAGE_LIMITS.maxSourceBytes) {
    throw new Error("image source exceeded its bounded input size");
  }
  if (!Number.isSafeInteger(maximumDataUrlBytes) || maximumDataUrlBytes <= 0) {
    throw new Error("invalid image transport bound");
  }
  const source = sharp(bytes, {
    failOn: "error",
    limitInputPixels: CODEX_IMAGE_LIMITS.maxInputPixels,
  }).rotate();
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height) throw new Error("image dimensions were unavailable");

  // `high` vision inputs are bounded to a 2048px maximum dimension. Resize
  // once before JSONL transport so the subscription worker does not pay to
  // base64 or tokenize pixels the model would discard anyway.
  const attempts = [
    { dimension: CODEX_IMAGE_LIMITS.maxDimension, quality: 84 },
    { dimension: 1_792, quality: 78 },
    { dimension: 1_536, quality: 72 },
    { dimension: 1_280, quality: 66 },
    { dimension: 1_024, quality: 60 },
  ];
  for (const attempt of attempts) {
    const encoded = await source
      .clone()
      .resize({
        width: attempt.dimension,
        height: attempt.dimension,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: attempt.quality, effort: 4 })
      .toBuffer();
    const dataUrl = `data:image/webp;base64,${encoded.toString("base64")}`;
    if (Buffer.byteLength(dataUrl, "utf8") <= maximumDataUrlBytes) return dataUrl;
  }
  throw new Error("image could not be encoded within the Codex input bound");
}

export async function materializeCodexChatImages(
  userText: string,
  attachments: readonly ImageAttachment[],
  options: ImageInputOptions = {},
): Promise<CodexImageInput[]> {
  const { signal, ...dependencyOverrides } = options;
  const deps = { ...defaultDependencies, ...dependencyOverrides };
  const sources: ImageSource[] = [];
  const captureId = trustedCaptureId(userText);
  if (captureId) {
    sources.push({
      label: "camera or screen capture submitted with this message",
      maximumBytes: CODEX_IMAGE_LIMITS.maxSourceBytes,
      read: async (readSignal) => await deps.getPrivate(privateCaptureObjectKey(captureId), readSignal),
    });
  } else {
    const legacyCapture = trustedCaptureUrl(userText);
    if (legacyCapture) {
      sources.push({
        label: "camera or screen capture submitted with this message",
        maximumBytes: CODEX_IMAGE_LIMITS.maxSourceBytes,
        read: async (readSignal) => await deps.fetchCapture(legacyCapture, readSignal),
      });
    }
  }
  const remaining = CODEX_IMAGE_LIMITS.maxInputs - sources.length;
  for (const file of attachments.filter((item) => isImageMime(item.mimeType)).slice(0, remaining)) {
    const maximumBytes = Math.min(
      CODEX_IMAGE_LIMITS.maxSourceBytes,
      Math.max(1, Math.floor(file.sizeBytes)),
    );
    sources.push({
      label: `attachment fileId=${serializeUntrustedFileValue(file.fileId, 128)} name=${serializeUntrustedFileValue(file.relativePath || file.name, 512)}`,
      maximumBytes,
      read: async (readSignal) => await deps.getPrivate(file.r2Key, readSignal),
    });
  }

  // Private R2 objects and the trusted capture are independent. Fetch their
  // bounded byte payloads concurrently, then preserve deterministic ordering
  // and transport-budget allocation while normalising them below.
  const sourceBytes = await Promise.all(sources.map(async (source) => {
    try {
      return await withImageReadDeadline(
        async (readSignal) => {
          const response = await source.read(readSignal);
          return await responseImageBytes(response, source.maximumBytes);
        },
        signal,
        Math.min(CODEX_IMAGE_LIMITS.fetchTimeoutMs, CODEX_IMAGE_LIMITS.batchTimeoutMs),
      );
    } catch {
      if (signal?.aborted) throw abortError(signal, "image materialization cancelled");
      return null;
    }
  }));
  const output: CodexImageInput[] = [];
  let usedTransportBytes = 0;
  for (let index = 0; index < sources.length; index += 1) {
    if (signal?.aborted) throw abortError(signal, "image materialization cancelled");
    const source = sources[index];
    const remainingSources = sources.length - index;
    const labelReserveBytes = remainingSources * 512;
    const fairDataUrlBytes = Math.floor(
      (CODEX_IMAGE_LIMITS.maxTransportBytes - usedTransportBytes - labelReserveBytes) / remainingSources,
    );
    const maximumDataUrlBytes = Math.min(
      CODEX_IMAGE_LIMITS.maxDataUrlBytesPerImage,
      fairDataUrlBytes,
    );
    let result: CodexImageInput;
    try {
      const bytes = sourceBytes[index];
      if (!bytes) throw new Error("image source unavailable");
      const dataUrl = await codexInlineImageFromBytes(bytes, maximumDataUrlBytes);
      if (signal?.aborted) throw abortError(signal, "image materialization cancelled");
      result = { status: "ready", label: source.label, dataUrl };
    } catch {
      if (signal?.aborted) throw abortError(signal, "image materialization cancelled");
      result = { status: "unavailable", label: source.label };
    }
    output.push(result);
    usedTransportBytes += Buffer.byteLength(JSON.stringify(result), "utf8");
  }
  return boundedCodexImageInputs(output);
}
