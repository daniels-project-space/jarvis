import { createRoot } from "react-dom/client";
import { useState } from "react";
import { MediaCard, type Attachment } from "../../src/components/MediaCard";

const fixtureArtifact: Attachment = {
  type: "image",
  value: "/api/creation-media?id=fixture-mindmap&variant=asset",
  title: "Seville days · mind map.svg",
  downloadUrl: "/api/creation-download?id=fixture-mindmap",
};

function ArtifactCardFixture() {
  const [shown, setShown] = useState<Attachment | null>(null);

  return (
    <main aria-label="Artifact card fixture">
      <p>Local fixture · no connected data</p>
      <MediaCard a={fixtureArtifact} onShow={(attachment) => setShown(attachment)} />
      <output aria-label="Shown artifact">{shown?.value ?? "not shown"}</output>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Artifact card fixture root is missing.");
createRoot(root).render(<ArtifactCardFixture />);
