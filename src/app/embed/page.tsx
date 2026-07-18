import JarvisUI from "@/components/JarvisUI";

// The Hub no longer runs a reduced second Jarvis implementation. The embed is
// the canonical client in a compact host frame: same particle orb, voice loop,
// tools, panels, work state, captions, memory and conversation threads.
export default function Embed() {
  return (
    <main className="relative z-10 flex h-dvh flex-col overflow-hidden">
      <JarvisUI embedded />
    </main>
  );
}
