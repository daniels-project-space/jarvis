import { createRoot } from "react-dom/client";
import { FileWorkspaceView } from "../../src/components/FileWorkspace";
import type { WorkspaceFile } from "../../src/lib/file-workspace";

const now = Date.now();
const files: WorkspaceFile[] = [
  { fileId: "brief", name: "launch-brief.md", relativePath: "Projects/Jarvis/launch-brief.md", mimeType: "text/markdown", sizeBytes: 18_400, status: "ready", summary: "Voice, orb, and file workspace launch brief.", reviewState: "favorite", tags: ["jarvis", "launch"], createdAt: now - 6_000, updatedAt: now - 2_000 },
  { fileId: "roadmap", name: "roadmap.md", relativePath: "Projects/Jarvis/roadmap.md", mimeType: "text/markdown", sizeBytes: 8_200, status: "ready", summary: "Current delivery roadmap and next decisions.", tags: ["roadmap"], createdAt: now - 12_000, updatedAt: now - 5_000 },
  { fileId: "invoice", name: "august-invoice.pdf", relativePath: "Business/Acme/august-invoice.pdf", mimeType: "application/pdf", sizeBytes: 248_000, status: "ready", summary: "Acme August invoice.", tags: ["finance", "acme"], createdAt: now - 18_000, updatedAt: now - 8_000 },
  { fileId: "campaign", name: "campaign-board.png", relativePath: "Business/Social/campaign-board.png", mimeType: "image/png", sizeBytes: 1_920_000, status: "ready", summary: "Social campaign concept board.", tags: ["social", "campaign"], createdAt: now - 30_000, updatedAt: now - 10_000 },
  { fileId: "decision", name: "supplier-decision.txt", relativePath: "Decisions/supplier-decision.txt", mimeType: "text/plain", sizeBytes: 4_100, status: "ready", summary: "Needs owner review before supplier confirmation.", reviewState: "review_remove", tags: ["decision"], createdAt: now - 36_000, updatedAt: now - 12_000 },
  { fileId: "voice", name: "maya-check-in.m4a", relativePath: "People/Maya/maya-check-in.m4a", mimeType: "audio/mp4", sizeBytes: 842_000, status: "ready", summary: "Maya weekly check-in.", tags: ["maya", "meeting"], createdAt: now - 42_000, updatedAt: now - 14_000 },
];

function FileWorkspaceFixture() {
  return (
    <main aria-label="Jarvis file workspace fixture" className="h-dvh w-screen overflow-hidden bg-[#05070d] p-4">
      <section className="mx-auto flex h-full max-w-6xl overflow-hidden rounded-[28px] border border-cyan/20 bg-[#07131e]/95 shadow-[0_36px_120px_rgba(0,0,0,.6)]">
        <FileWorkspaceView files={files} />
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("File-workspace fixture root is missing.");
createRoot(root).render(<FileWorkspaceFixture />);
