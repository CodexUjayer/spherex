import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ErrorGuard } from "@/components/spherex/error-guard";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SPHEREx Explorer",
  description:
    "Explore real NASA/IPAC IRSA SPHEREx observations of any sky position. Compare observations across dates with single, blink and difference views.",
  keywords: ["SPHEREx", "NASA", "IRSA", "astronomy", "infrared", "space apps"],
  authors: [{ name: "SPHEREx Explorer" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "SPHEREx Explorer",
    description: "Live NASA/IPAC IRSA SPHEREx data, any sky position.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <ErrorGuard />
        {children}
        <Toaster />
      </body>
    </html>
  );
}
