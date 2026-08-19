import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

/*
 * `next/font` downloads the face at build time and serves it from this origin.
 * The site makes no request to a third party at runtime — no font CDN, no
 * analytics, no embed. A page about not sending data anywhere should not.
 */
const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-jakarta",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://standfast.ai"),
  title: {
    default: "Standfast — a shared knowledge layer for coding agents",
    template: "%s — Standfast",
  },
  description:
    "Standfast holds a project's decisions, conventions and constraints, serves each agent only what governs the file in front of it over MCP, and records whether the code still honors them. Source code never leaves the machine.",
  applicationName: "Standfast",
  keywords: [
    "coding agents",
    "MCP",
    "Model Context Protocol",
    "project knowledge",
    "agent memory",
    "code review",
  ],
  openGraph: {
    type: "website",
    siteName: "Standfast",
    title: "Standfast — a shared knowledge layer for coding agents",
    description:
      "Agents read the code. Standfast keeps the verdict. It never sees the source.",
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: "Standfast — a shared knowledge layer for coding agents",
    description:
      "Agents read the code. Standfast keeps the verdict. It never sees the source.",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#FFFBF2",
  colorScheme: "light",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={jakarta.variable}>
      <body className="min-h-screen bg-surface text-on-surface antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-md focus:top-md focus:z-[60] focus:rounded-full focus:bg-secondary focus:px-md focus:py-sm focus:text-label-lg focus:text-surface"
        >
          Skip to content
        </a>
        <SiteHeader />
        <main id="main">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
