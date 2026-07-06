// Offline fallback shown for document navigations when the network is down.
// Precached by Serwist (see next.config.mjs additionalPrecacheEntries and the
// fallbacks entry in app/sw.ts). Any score already tapped is safe in the
// IndexedDB queue and syncs on reconnect.
export const metadata = { title: 'Offline — Roundmaster' };

export default function OfflinePage() {
  return (
    <main className="grid min-h-dvh place-items-center bg-slate-950 px-6 text-center">
      <div className="max-w-sm space-y-3">
        <h1 className="text-2xl font-black text-slate-50">You are offline</h1>
        <p className="text-sm text-slate-400">
          Any scores you have already confirmed are saved on this device and
          will sync automatically when you are back online.
        </p>
      </div>
    </main>
  );
}
