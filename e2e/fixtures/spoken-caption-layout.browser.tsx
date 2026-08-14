import { createRoot } from "react-dom/client";
import {
  SPOKEN_CAPTION_TEXT_CLASS,
  spokenCaptionStageClassName,
} from "../../src/lib/spoken-caption-layout";
import "./spoken-caption-layout.fixture.css";

const compactAside = new URLSearchParams(window.location.search).get("mode") === "compact";
const stageClassName = spokenCaptionStageClassName({
  compactAside,
  commandExpanded: false,
  overlayUp: false,
});

function SpokenCaptionFixture() {
  return (
    <main
      className="caption-fixture-shell"
      data-caption-mode={compactAside ? "compact" : "main"}
      aria-label="Spoken caption layout fixture"
    >
      <p className="caption-fixture-label">Local responsive caption validation</p>
      <div className="caption-fixture-orb" aria-hidden />
      <div
        data-caption-stage
        data-caption-layout={stageClassName}
        className={["pointer-events-none", "absolute", stageClassName, "z-30", "flex", "justify-center", "px-6"].join(" ")}
      >
        <div
          data-jarvis-caption
          data-caption-phase="listening"
          className={[
            "cap-bloom",
            "max-h-[24vh]",
            "max-w-[min(780px,86%)]",
            "overflow-hidden",
            "text-center",
            SPOKEN_CAPTION_TEXT_CLASS,
            "text-ice",
          ].join(" ")}
        >
          Finding the next step while you speak.
        </div>
      </div>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Spoken caption fixture root is missing.");

createRoot(root).render(<SpokenCaptionFixture />);
