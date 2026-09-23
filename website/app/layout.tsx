import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Inter } from "next/font/google";
import Script from "next/script";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
});

const siteConfig = {
  name: "Ghostly",
  title: "Ghostly — Private chat and sharing, peer to peer",
  description:
    "Private conversations, files and sats through supported peer-to-peer connections. Explore the Ghostly app, its open contracts and the possibilities ahead. Free and open source.",
  url: "https://ghostly.tools",
  ogImage: "https://ghostly.tools/og-image.png",
  keywords: [
    "encrypted chat",
    "ephemeral messaging",
    "DHT",
    "decentralized",
    "privacy",
    "end-to-end encryption",
    "serverless chat",
    "pkarr",
    "mainline DHT",
    "secure messaging",
    "localhost sharing",
    "peer-to-peer file transfer",
    "Cashu wallet",
  ],
};

export const viewport: Viewport = {
  themeColor: "#060a10",
  width: "device-width",
  initialScale: 1,
};

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.url),
  title: {
    default: siteConfig.title,
    template: `%s | ${siteConfig.name}`,
  },
  description: siteConfig.description,
  keywords: siteConfig.keywords,
  authors: [{ name: "Miguel Medeiros" }],
  creator: "Miguel Medeiros",
  publisher: "Miguel Medeiros",
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
    apple: "/apple-touch-icon.png",
  },
  manifest: "/site.webmanifest",
  openGraph: {
    type: "website",
    locale: "en_US",
    url: siteConfig.url,
    siteName: siteConfig.name,
    title: siteConfig.title,
    description: siteConfig.description,
    images: [
      {
        url: siteConfig.ogImage,
        width: 1200,
        height: 630,
        alt: "Ghostly — private chat, calls, files, sats and local app sharing",
        type: "image/png",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: siteConfig.title,
    description: siteConfig.description,
    images: [siteConfig.ogImage],
    creator: "@paborsa",
  },
  alternates: {
    canonical: siteConfig.url,
  },
  category: "technology",
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: siteConfig.name,
  description: siteConfig.description,
  url: siteConfig.url,
  applicationCategory: "CommunicationApplication",
  operatingSystem: "macOS, Windows, Linux, Web, Android (Web), iOS (Web)",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
  author: {
    "@type": "Person",
    name: "Miguel Medeiros",
    url: "https://miguelmedeiros.dev",
  },
  featureList: [
    "End-to-end encryption",
    "Voice and video in supported legacy chats",
    "Screen sharing in compatible legacy chats on supported computers",
    "Peer-to-peer file transfers up to 100 MiB",
    "Cashu ecash wallet with Lightning payments",
    "Local web app sharing through compatible legacy desktop and extension chats",
    "Decentralized DHT network",
    "No account needed",
    "Command-line text messaging for scripts and bots",
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark scroll-smooth" data-scroll-behavior="smooth">
      <head>
        <Script
          src="https://www.googletagmanager.com/gtag/js?id=G-KXK4ESQ5DZ"
          strategy="afterInteractive"
        />
        <Script id="google-analytics" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', 'G-KXK4ESQ5DZ');
          `}
        </Script>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body
        className={`${inter.variable} ${jetbrains.variable} antialiased bg-[#060a10] text-gray-100`}
      >
        {children}
      </body>
    </html>
  );
}
