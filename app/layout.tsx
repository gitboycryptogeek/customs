import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Customs Compliance Lookup",
  description: "Deterministic duty, levy and condition lookup with legal citations.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
