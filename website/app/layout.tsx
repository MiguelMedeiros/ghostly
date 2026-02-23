import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Inter } from "next/font/google";
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
  title: "Ghostly — Encrypted Ephemeral Chat over the DHT",
  description:
    "Serverless, end-to-end encrypted, ephemeral messaging. No accounts, no servers. Messages travel through 10M+ DHT nodes and vanish when you stop.",
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
    "no servers",
    "anonymous chat",
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
  authors: [{ name: "Synonym" }],
  creator: "Synonym",
  publisher: "Synonym",
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
        alt: "Ghostly - Encrypted Ephemeral Chat over the DHT",
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
  operatingSystem: "macOS, Windows, Linux",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
  author: {
    "@type": "Organization",
    name: "Synonym",
    url: "https://synonym.to",
  },
  featureList: [
    "End-to-end encryption",
    "Ephemeral messaging",
    "Decentralized DHT network",
    "No servers required",
    "No account needed",
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark scroll-smooth">
      <head>
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
