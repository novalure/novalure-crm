import type { Metadata, Viewport } from "next";
import { LanguageHtmlSync } from "@/components/language-html-sync";
import "./globals.css";

export const metadata: Metadata = {
  title: "Novalure CRM",
  description: "Real estate CRM, funnel and AI lead platform",
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    shortcut: ["/icon.svg"],
  },
};

export const viewport: Viewport = {
  themeColor: "#d9ecff",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de" className="h-full">
      <body className="flex min-h-full flex-col antialiased">
        <LanguageHtmlSync />
        {children}
      </body>
    </html>
  );
}
