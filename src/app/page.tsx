import Chat from "@/components/Chat";
import Avatar from "@/components/Avatar";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col bg-neutral-950 font-mono text-neutral-100">
      <header className="p-4 text-center">
        <h1 className="text-2xl font-semibold tracking-[0.3em] text-emerald-400">JARVIS</h1>
        <p className="text-[10px] text-neutral-600">on your Max subscription · Convex memory · R2 vault</p>
      </header>
      <div className="mx-auto grid w-full max-w-6xl flex-1 gap-4 p-4 md:grid-cols-2">
        <div className="relative min-h-[45vh] overflow-hidden rounded-2xl border border-neutral-800 bg-gradient-to-b from-neutral-900 to-neutral-950">
          <Avatar />
        </div>
        <div className="flex">
          <Chat />
        </div>
      </div>
    </main>
  );
}
