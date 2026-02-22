import type { Metadata } from "next";
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

export const metadata: Metadata = {
  title: "Dead Drop — Encrypted Ephemeral Chat over the DHT",
  description:
    "Serverless, end-to-end encrypted, ephemeral messaging. No accounts, no servers. Messages travel through 10M+ DHT nodes and vanish when you stop.",
  icons: { icon: "/favicon.svg" },
  openGraph: {
    title: "Dead Drop — Encrypted Ephemeral Chat over the DHT",
    description:
      "Serverless, end-to-end encrypted, ephemeral messaging through the Mainline DHT.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark scroll-smooth">
      <body
        className={`${inter.variable} ${jetbrains.variable} antialiased bg-[#060a10] text-gray-100`}
      >
        {children}
      </body>
    </html>
  );
}
