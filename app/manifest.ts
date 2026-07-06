import type { MetadataRoute } from 'next';

/**
 * Native App Router manifest (Next.js serves this at /manifest.webmanifest).
 * Standalone display + maskable icons = installable, chrome-free app on iOS/Android.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'NZMMAF Roundmaster',
    short_name: 'Roundmaster',
    description: 'Ringside round-by-round scoring for NZMMAF judges.',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#020617', // slate-950
    theme_color: '#020617',
    categories: ['sports', 'productivity'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
