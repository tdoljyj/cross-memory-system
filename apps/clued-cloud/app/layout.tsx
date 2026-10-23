import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  // Keep share assets on the serving origin until the new domains are bound.
  metadataBase: new URL("https://kooyomi.com"),
  title: "BeamingFace — 好的发现，会写在脸上。",
  description:
    "有趣的内容，好用的应用，还有让人眼前一亮的新玩法。",
  openGraph: {
    title: "BeamingFace — 好的发现，会写在脸上。",
    description:
      "有趣的内容，好用的应用，还有让人眼前一亮的新玩法。",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "BeamingFace — 好的发现，会写在脸上。" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "BeamingFace — 好的发现，会写在脸上。",
    description:
      "有趣的内容，好用的应用，还有让人眼前一亮的新玩法。",
    images: ["/og.png"],
  },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml", sizes: "16x16" },
      { url: "/beamingface-symbol-flat.svg", type: "image/svg+xml", sizes: "32x32" },
      { url: "/beamingface-symbol.svg", type: "image/svg+xml", sizes: "48x48" },
    ],
    shortcut: "/favicon.svg",
    apple: { url: "/apple-touch-icon.png", sizes: "180x180" },
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
