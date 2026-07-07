import type { Metadata } from 'next';
import { Fraunces, Inter, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

// The "Dailies" design system's three-typeface stack: Fraunces for
// display/serif (headings, titles), Inter for body/UI, IBM Plex Mono for
// timecodes/file IDs/anything that's literal data. Loaded via next/font
// rather than a <link> tag so they're self-hosted at build time (no
// runtime request to Google Fonts, no flash of unstyled text).
const fraunces = Fraunces({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  style: ['normal', 'italic'],
  variable: '--font-fraunces',
});

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-inter',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex-mono',
});

export const metadata: Metadata = {
  title: 'Dailies — footage in, story out',
  description:
    'Drive footage in, editor-ready narrative + short-form exports out. Whisper transcription, Claude narrative generation, FCPXML timeline export.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${inter.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
