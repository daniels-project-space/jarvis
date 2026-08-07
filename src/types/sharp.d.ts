// sharp 0.35 publishes its declarations at lib/index.d.ts but omits the
// `types` condition from its package exports. Keep this narrow bridge until
// upstream exposes those declarations to TypeScript's bundler resolution.
declare module "sharp" {
  type Metadata = { width?: number; height?: number; format?: string };
  type Sharp = {
    metadata(): Promise<Metadata>;
    clone(): Sharp;
    rotate(): Sharp;
    resize(options: { width?: number; height?: number; fit?: "inside"; withoutEnlargement?: boolean }): Sharp;
    webp(options?: { quality?: number; effort?: number }): Sharp;
    toBuffer(): Promise<Buffer>;
  };
  export default function sharp(
    input: Uint8Array,
    options?: { failOn?: "error" | "warning" | "truncated" | "none"; limitInputPixels?: number | boolean },
  ): Sharp;
}
