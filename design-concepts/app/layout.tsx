import type { Metadata } from "next";
import "@fontsource-variable/inter";
import "./globals.css";

export const metadata: Metadata = {
  title: "Evelyn CRM – Design Concepts",
  description: "Drei interaktive Designkonzepte für Evelyn. Ausschließlich synthetische Demodaten.",
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="de"><body>{children}</body></html>;
}
