import Link from 'next/link';

// Minimal landing page. Judges sign in from here; officials get their own
// dashboard in a later build (see BLUEPRINT.md, section 9).
export default function HomePage() {
  return (
    <main className="grid min-h-dvh place-items-center bg-slate-950 px-6 text-center">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
            NZMMAF
          </p>
          <h1 className="text-4xl font-black text-slate-50">Roundmaster</h1>
          <p className="text-sm text-slate-400">
            Ringside round-by-round scoring for judges.
          </p>
        </div>

        <Link
          href="/login"
          className="block h-14 rounded-xl bg-slate-50 text-lg font-bold leading-[3.5rem] text-slate-950"
        >
          Judge sign-in
        </Link>
      </div>
    </main>
  );
}
