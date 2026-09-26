import type { Metadata } from "next";
import { Barlow, Barlow_Condensed, JetBrains_Mono } from "next/font/google";
import TopBar from "@/components/TopBar";
import "./globals.css";

// Body: Barlow — slightly rounded grotesk from road/signage lettering.
const body = Barlow({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

// Display: Barlow Condensed — used only for the wordmark.
const display = Barlow_Condensed({
  variable: "--font-display-face",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

// Mono: task keys, times, branch names — the "timing screen" data.
const code = JetBrains_Mono({
  variable: "--font-code",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Pit Crew",
  description: "Project-aware agent for small coding teams",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${body.variable} ${display.variable} ${code.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <TopBar />
        {children}
      </body>
    </html>
  );
}
