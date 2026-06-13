import type { Metadata } from "next";
import { Archivo, Archivo_Narrow, Fraunces, JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { ToastProvider } from "@/components/ui/Toast";
import "./globals.css";

const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-sans",
  weight: ["300", "400", "500", "600"],
});

const archivoNarrow = Archivo_Narrow({
  subsets: ["latin"],
  variable: "--font-narrow",
  weight: ["400", "500", "600"],
});

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-serif",
  weight: "variable",
  style: ["normal", "italic"],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "AXIS[CKO] — Personal Operating System",
  description: "Signal console, fund, and schedule — your personal operating system.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Bebas Neue not available via next/font — load via Google Fonts link */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Playfair+Display:ital,wght@0,400..700;1,400&family=Space+Grotesk:wght@400;500;600&family=Inter:wght@300;400;500&family=IBM+Plex+Sans:wght@300;400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className={`${archivo.variable} ${archivoNarrow.variable} ${fraunces.variable} ${jetbrainsMono.variable}`}>
        <ThemeProvider>
          <ToastProvider>{children}</ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
