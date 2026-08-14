import { createRoot } from "react-dom/client";
import { PdfView } from "../../src/components/Views";

function PrivatePdfViewerFixture() {
  return (
    <main aria-label="Private PDF viewer fixture">
      <p>Local fixture · production owner authorization is covered separately.</p>
      <PdfView url="/api/files/fixture-pdf" title="Fixture itinerary" />
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Private PDF fixture root is missing.");
createRoot(root).render(<PrivatePdfViewerFixture />);
