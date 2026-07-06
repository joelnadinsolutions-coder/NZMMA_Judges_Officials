'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSupabase } from '@/lib/supabase/client';

export default function LoginPage() {
  const supabase = getSupabase();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [signedInEmail, setSignedInEmail] = useState<string | null>(null);

  // When the magic link redirects back here, the client picks up the session
  // from the URL (detectSessionInUrl). Reflect that so it does not look like a
  // loop back to the sign-in form.
  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({ data }) => setSignedInEmail(data.session?.user?.email ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setSignedInEmail(session?.user?.email ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, [supabase]);

  async function signIn() {
    setErr(null);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      // Redirect to this page (not "/"): the home page is a static server
      // component that never creates a Supabase client, so it cannot capture
      // the session from the URL. The login page does.
      options: {
        emailRedirectTo:
          typeof window !== 'undefined' ? `${window.location.origin}/login` : undefined,
      },
    });
    if (error) setErr(error.message);
    else setSent(true);
  }

  async function signOut() {
    await supabase.auth.signOut();
    setSignedInEmail(null);
    setSent(false);
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-slate-950 px-6">
      <div className="w-full max-w-sm space-y-4 text-center">
        <h1 className="text-3xl font-black text-slate-50">Roundmaster</h1>
        <p className="text-sm text-slate-400">Judge sign-in</p>
        {signedInEmail ? (
          <div className="space-y-3">
            <p className="rounded-xl bg-emerald-500/15 p-4 text-emerald-300">
              Signed in as {signedInEmail}.
            </p>
            <p className="text-sm text-slate-400">
              Open the bout link an official gives you to start scoring.
            </p>
            <Link
              href="/admin"
              className="block h-12 rounded-xl bg-slate-50 text-sm font-bold leading-[3rem] text-slate-950"
            >
              Officials dashboard
            </Link>
            <button
              onClick={signOut}
              className="h-12 w-full rounded-xl bg-slate-800 text-sm font-semibold text-slate-300"
            >
              Sign out
            </button>
          </div>
        ) : sent ? (
          <p className="rounded-xl bg-emerald-500/15 p-4 text-emerald-300">
            Check your email for a sign-in link.
          </p>
        ) : (
          <>
            <input
              type="email"
              inputMode="email"
              placeholder="you@nzmmaf.org"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-14 w-full rounded-xl bg-slate-900 px-4 text-lg text-slate-50 ring-1 ring-slate-700"
            />
            <button
              onClick={signIn}
              disabled={!email}
              className="h-14 w-full rounded-xl bg-slate-50 text-lg font-bold text-slate-950 disabled:opacity-40"
            >
              Send sign-in link
            </button>
            {err && <p className="text-sm text-red-400">{err}</p>}
          </>
        )}
      </div>
    </div>
  );
}
