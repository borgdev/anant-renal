import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://renal-swarm-intelligence.bayyagari.chatgpt.site"),
  title: "Renal Swarm Intelligence",
  description:
    "An event-native, governed business outcome harness for dialysis care, operations and regulatory intelligence.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  openGraph: {
    type: "website",
    url: "https://renal-swarm-intelligence.bayyagari.chatgpt.site",
    siteName: "Renal Swarm Intelligence",
    title: "Renal Swarm Intelligence",
    description: "A governed business outcome harness for dialysis.",
    images: [{ url: "/og.png", width: 1731, height: 909, alt: "Renal Swarm Intelligence temporal evidence network" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Renal Swarm Intelligence",
    description: "A governed business outcome harness for dialysis.",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
