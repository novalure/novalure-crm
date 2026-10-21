import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/inter";
import "../styles/tokens.css";
import "../styles/foundations.css";
import "../styles/shell.css";
import "../styles/dashboard.css";
import "../styles/domains.css";

export const metadata: Metadata = {
  title: "Evelyn AI Command Center · Design C",
  description:
    "Isolierte Design-C-Vorschau. Ausschließlich synthetische Demodaten.",
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="de">
      <body>{children}</body>
    </html>
  );
}
