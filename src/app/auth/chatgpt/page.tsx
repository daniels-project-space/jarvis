import type { Metadata } from "next";
import { CodexAuthGuide } from "@/components/CodexAuthGuide";

export const metadata: Metadata = {
  title: "Reconnect ChatGPT · Jarvis",
  robots: { index: false, follow: false },
};

export default function ChatGPTAuthPage() {
  return <CodexAuthGuide />;
}
