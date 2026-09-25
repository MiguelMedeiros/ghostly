import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Inter } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import "./site.css";

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
  title: "Ghostly: Find each other. Talk peer to peer.",
  description:
    "Meet the people you choose through a private invitation, then chat, send files and sats, peer to peer. No account to create. Free and open source, built on small open contracts anyone can implement.",
  url: "https://ghostly.tools",
  ogImage: "https://ghostly.tools/og-image.png",
  keywords: [
    "encrypted chat",
    "peer-to-peer",
    "DHT",
    "pkarr",
    "mainline DHT",
    "WebRTC",
    "Iroh",
    "HyperDHT",
    "Cashu wallet",
    "localhost sharing",
    "peer-to-peer file transfer",
    "open protocol",
    "WISP",
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
    alternateLocale: ["pt_BR"],
    url: siteConfig.url,
    siteName: siteConfig.name,
    title: siteConfig.title,
    description: siteConfig.description,
    images: [
      {
        url: siteConfig.ogImage,
        width: 1200,
        height: 630,
        alt: "Ghostly: two friendly ghosts, Boo and Casper, talking peer to peer",
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

// Only what the public release (see lib/release.ts) does today.
const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: siteConfig.name,
  description: siteConfig.description,
  url: siteConfig.url,
  applicationCategory: "CommunicationApplication",
  operatingSystem: "macOS, Windows, Linux, Web",
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
    "Private one-to-one chat started from an invitation",
    "No account needed",
    "Peer-to-peer file transfers up to 100 MiB",
    "Voice, video and screen sharing over WebRTC",
    "Cashu ecash wallet with Lightning payments through the mint",
    "Sharing a local web app from the desktop app or browser extension",
    "Command-line text messaging for scripts and bots",
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        {/* Scenes only hold the screen when scripts run; without them every step reads in order. */}
        <Script id="js-flag" strategy="beforeInteractive">
          {"var d=document.documentElement;d.classList.add('js');try{var q=function(m,f){var l=matchMedia(m);f(l.matches);l.addEventListener('change',function(e){f(e.matches)})};q('(prefers-reduced-motion: reduce)',function(v){d.classList.toggle('calm',v)});q('(max-width: 860px)',function(v){if(v)d.dataset.orient='portrait';else delete d.dataset.orient});q('(pointer: coarse)',function(v){if(v)d.dataset.touch='';else delete d.dataset.touch})}catch(e){}"}
        </Script>
        {/* An invite link (ghostly.tools/#ghostly1…, WISP 801): its code leaves the address before analytics
            load (and, pasted later, before their history listeners run), so it is never in a page view, a
            referrer or the history. components/site/JoinLanding.tsx reads it. */}
        <Script id="invite-intake" strategy="beforeInteractive">
          {"try{var t=function(){var h=location.hash;if(!/^#ghostly1/i.test(h))return;var v=h.slice(1);try{v=decodeURIComponent(v)}catch(e){}window.__ghostlyInvite=v;history.replaceState(history.state,'',location.pathname+location.search);dispatchEvent(new Event('ghostly-invite'))};t();addEventListener('popstate',t);addEventListener('hashchange',t)}catch(e){}"}
        </Script>
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
