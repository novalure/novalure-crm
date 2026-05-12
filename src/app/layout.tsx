import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Novalure CRM",
  description: "Immobilien CRM, Funnel und KI Lead Plattform",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de" className="h-full">
      <body className="flex min-h-full flex-col antialiased">{children}</body>
    </html>
  );
}
