import Chat from "@/components/Chat";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-1 flex-col items-center justify-center gap-6 bg-neutral-950 p-6 font-mono text-neutral-100">
      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-[0.3em] text-emerald-400">JARVIS</h1>
        <p className="mt-2 text-xs text-neutral-500">personal ops assistant · brain + memory online</p>
      </div>
      <Chat />
      <p className="text-[10px] text-neutral-700">Opus · Convex memory · R2 vault · daniels-project-space/jarvis</p>
    </main>
  );
}
