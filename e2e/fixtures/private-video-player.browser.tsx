import { createRoot } from "react-dom/client";
import { PrivateVideoPlayer } from "../../src/components/PrivateVideoPlayer";

function PrivateVideoPlayerFixture() {
  return (
    <main aria-label="Private video player fixture">
      <p>Local fixture · production owner authorization is covered separately.</p>
      <PrivateVideoPlayer url="/api/files/fixture-video" title="Fixture travel video" />
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Private video fixture root is missing.");
createRoot(root).render(<PrivateVideoPlayerFixture />);
