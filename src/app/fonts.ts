import localFont from "next/font/local";

export const figtree = localFont({
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
  src: "./fonts/figtree-latin.woff2",
  style: "normal",
  variable: "--font-figtree",
  weight: "400 800",
});
