import type { Metadata, Viewport } from "next";
import { Chakra_Petch, Sora, Geist_Mono } from "next/font/google";
import "./globals.css";
import Providers from "./providers";

const chakra = Chakra_Petch({
  variable: "--font-chakra",
  weight: ["400", "600", "700"],
  subsets: ["latin"],
});

const sora = Sora({
  variable: "--font-sora",
  weight: ["400", "500", "600"],
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "JARVIS",
  description: "Daniel's personal AI",
};

export const viewport: Viewport = {
  themeColor: "#05070d",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${chakra.variable} ${sora.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <div className="hud-grid pointer-events-none fixed inset-0" aria-hidden />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
