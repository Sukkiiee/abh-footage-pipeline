import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ABH Footage Pipeline',
  description:
    'Drive footage in, editor-ready narrative + short-form exports out. Whisper transcription, Claude narrative generation, FCPXML timeline export.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
