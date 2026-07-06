import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'NZMMAF Roundmaster',
  description: 'Ringside round-by-round scoring for NZMMAF judges.',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Roundmaster' },
};

// High-contrast dark theme; cover the notch on installed iOS.
export const viewport: Viewport = {
  themeColor: '#020617',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-950 text-slate-50 antialiased select-none touch-manipulation">
        {children}
      </body>
    </html>
  );
}
