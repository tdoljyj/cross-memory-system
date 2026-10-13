import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://clued.pixelgrav.com"),
  title: "Kooyumi — Let the good continue.",
  description:
    "Find what's good. Keep it going.",
  openGraph: {
    title: "Kooyumi — Let the good continue.",
    description:
      "Find what's good. Keep it going.",
    type: "website",
    images: [{ url: "/og.png", width: 1731, height: 909, alt: "Kooyumi" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Kooyumi — Let the good continue.",
    description:
      "Find what's good. Keep it going.",
    images: ["/og.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var l=localStorage.getItem('clued-language');if(l!=='zh-CN'&&l!=='en'){l=(navigator.languages||[navigator.language]).some(function(x){return x&&x.toLowerCase().indexOf('zh')===0})?'zh-CN':'en'}document.documentElement.lang=l}catch(e){}",
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
