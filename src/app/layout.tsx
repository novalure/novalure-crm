import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import { LanguageHtmlSync } from "@/components/language-html-sync";
import {
  defaultLanguage,
  languageCookieName,
  languageRequestHeaderName,
  resolveLanguage,
} from "@/lib/language-runtime";
import { figtree } from "@/app/fonts";
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
  themeColor: "#faf9f7",
};

async function getInitialLanguage() {
  const requestHeaders = await headers();
  const headerLanguage = requestHeaders.get(languageRequestHeaderName);
  if (headerLanguage) return resolveLanguage(headerLanguage, defaultLanguage);

  const cookieStore = await cookies();
  return resolveLanguage(cookieStore.get(languageCookieName)?.value, defaultLanguage);
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const language = await getInitialLanguage();

  return (
    <html lang={language} className={`${figtree.variable} h-full`} suppressHydrationWarning>
      <body className="flex min-h-full flex-col antialiased">
        <LanguageHtmlSync />
        {children}
      </body>
    </html>
  );
}
