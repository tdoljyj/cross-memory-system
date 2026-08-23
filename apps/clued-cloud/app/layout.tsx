import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://clued.pixelgrav.com"),
  title: "Clued — One you. Every AI.",
  description:
    "A private, user-controlled context layer for every AI you authorize.",
  openGraph: {
    title: "Clued — One you. Every AI.",
    description:
      "A private, user-controlled context layer for every AI you authorize.",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Clued" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Clued — One you. Every AI.",
    description:
      "A private, user-controlled context layer for every AI you authorize.",
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
