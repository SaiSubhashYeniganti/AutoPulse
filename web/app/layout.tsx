import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Cars24 Brief — Daily auto-industry intelligence",
  description: "AI-aggregated brief on Indian used-car market and competitor moves. Read in 2 minutes.",
  robots: { index: false, follow: false }, // private demo build
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans selection:bg-apple-blue/20 selection:text-apple-blue">
        {children}
      </body>
    </html>
  );
}
