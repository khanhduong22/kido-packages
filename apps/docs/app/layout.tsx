import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import { Inter } from 'next/font/google';
import type { Metadata } from 'next';
import { appName, appDescription, appUrl } from '@/lib/shared';

const inter = Inter({
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL(appUrl),
  title: {
    default: `${appName} — The Shadcn for Distributed Systems`,
    template: `%s | ${appName}`,
  },
  description: appDescription,
  openGraph: {
    title: `${appName} — The Shadcn for Distributed Systems`,
    description: appDescription,
    url: appUrl,
    siteName: appName,
    type: 'website',
  },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`dark ${inter.className}`} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen bg-[#0d0e11] text-[#f4f4f5] antialiased">
        <RootProvider theme={{ defaultTheme: 'dark' }}>{children}</RootProvider>
      </body>
    </html>
  );
}
