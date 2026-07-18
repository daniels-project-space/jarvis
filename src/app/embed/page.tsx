import JarvisUI from "@/components/JarvisUI";

// The Hub uses the canonical brain and voice loop but renders only their
// particle orb/captions. Full chat, panels, work cards, and navigation belong
// to the main Jarvis workspace and must never be duplicated in this overlay.
export default function Embed() {
  return (
    <main className="relative z-10 flex h-dvh flex-col overflow-hidden">
      <JarvisUI embedded />
    </main>
  );
}
