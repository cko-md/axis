import type { Metadata } from "next";
import {
  Archivo,
  Archivo_Narrow,
  Fraunces,
  JetBrains_Mono,
  Playfair_Display,
  Space_Grotesk,
  Inter,
  IBM_Plex_Sans,
  Bebas_Neue,
} from "next/font/google";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { ToastProvider } from "@/components/ui/Toast";
import { WebViewerProvider } from "@/lib/hooks/useWebViewer";
import { WebViewer } from "@/components/ui/WebViewer";
import BiometricGate from "@/components/auth/BiometricGate";
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

// ── Optional faces selectable in Interface Studio (display + body). ──
// These MUST be loaded here so their CSS variables exist; otherwise the
// face pickers silently fall back to the defaults and "do nothing".
const playfair = Playfair_Display({
  subsets: ["latin"],
  variable: "--font-playfair",
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  display: "swap",
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-grotesk",
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  weight: ["300", "400", "500", "600"],
  display: "swap",
});

const ibmPlexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  variable: "--font-plex",
  weight: ["300", "400", "500", "600"],
  display: "swap",
});

const bebasNeue = Bebas_Neue({
  subsets: ["latin"],
  variable: "--font-bebas",
  weight: "400",
  display: "swap",
});

export const metadata: Metadata = {
  title: "AXIS[CKO] — Personal Operating System",
  description: "Signal console, fund, and schedule — your personal operating system.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="manifest" href="/manifest.json" />
        <link
          rel="stylesheet"
          href="https://api.fontshare.com/v2/css?f[]=array@400,700&f[]=tanker@400&f[]=neco@400,700&f[]=nippo@400,700&f[]=telma@400,700&f[]=boxing@400,700&f[]=kola@400,700&f[]=ranade@400,700&f[]=sora@400,700&f[]=public-sans@400,700&f[]=nunito@400,700&f[]=montserrat@400,700&f[]=red-hat-display@400,700&f[]=firasans@400,700&f[]=anton@400&f[]=teko@400,700&f[]=azeret-mono@400,700&display=swap"
        />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Axis" />
        <meta name="theme-color" content="#0a0b0e" />
      </head>
      <body className={`${archivo.variable} ${archivoNarrow.variable} ${fraunces.variable} ${jetbrainsMono.variable} ${playfair.variable} ${spaceGrotesk.variable} ${inter.variable} ${ibmPlexSans.variable} ${bebasNeue.variable}`}>
        <WebViewerProvider>
          <ThemeProvider>
            <ToastProvider>
              {children}
              <BiometricGate />
            </ToastProvider>
          </ThemeProvider>
          <WebViewer />
        </WebViewerProvider>
        <SpeedInsights />
      </body>
    </html>
  );
}
