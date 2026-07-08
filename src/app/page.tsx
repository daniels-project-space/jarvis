import JarvisUI from "@/components/JarvisUI";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col bg-neutral-950 font-mono text-neutral-100">
      <header className="p-4 text-center">
        <h1 className="text-2xl font-semibold tracking-[0.3em] text-emerald-400">JARVIS</h1>
        <p className="text-[10px] text-neutral-600">on your Max subscription · Convex memory · R2 vault</p>
      </header>
      <JarvisUI />
    </main>
  );
}
