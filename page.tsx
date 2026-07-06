'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSupabase } from '@/lib/supabase/client';

type Mode = 'signin' | 'signup' | 'magic';

export default function LoginPage() {
  const supabase = getSupabase();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [signedInEmail, setSignedInEmail] = useState<string | null>(null);

  // When a magic link redirects back here, the client picks up the session
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

  function resetMessages() {
    setErr(null);
    setNotice(null);
  }

  async function signInWithPassword() {
    resetMessages();
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) setErr(error.message);
    // Success is reflected by onAuthStateChange flipping signedInEmail.
  }

  async function signUpWithPassword() {
    resetMessages();
    if (password.length < 8) {
      setErr('Password must be at least 8 characters.');
      return;
    }
    setBusy(true);
    const { data, error } = await supabase.auth.signUp({ email, password });
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    // If email confirmation is ON in Supabase, no session is returned until
    // the user confirms. If it is OFF, they are signed in immediately and the
    // on_auth_user_created trigger has created their pending judge profile.
    if (data.session) {
      setNotice('Account created. An official must approve you before you can score.');
    } else {
      setNotice('Account created. Check your email to confirm, then sign in.');
    }
  }

  async function sendMagicLink() {
    resetMessages();
    setBusy(true);
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
    setBusy(false);
    if (error) setErr(error.message);
    else setNotice('Check your email for a sign-in link.');
  }

  async function signOut() {
    await supabase.auth.signOut();
    setSignedInEmail(null);
    resetMessages();
  }

  const inputCls =
    'h-14 w-full rounded-xl bg-slate-900 px-4 text-lg text-slate-50 ring-1 ring-slate-700';
  const primaryBtnCls =
    'h-14 w-full rounded-xl bg-slate-50 text-lg font-bold text-slate-950 disabled:opacity-40';
  const linkBtnCls = 'text-sm text-slate-400 underline underline-offset-4';

  return (
    <div className="grid min-h-dvh place-items-center bg-slate-950 px-6">
      <div className="w-full max-w-sm space-y-4 text-center">
        <h1 className="text-3xl font-black text-slate-50">Roundmaster</h1>
        <p className="text-sm text-slate-400">
          {mode === 'signup' ? 'Create a judge account' : 'Judge sign-in'}
        </p>

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
        ) : (
          <>
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@nzmmaf.org"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputCls}
            />

            {mode !== 'magic' && (
              <input
                type="password"
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputCls}
              />
            )}

            {mode === 'signin' && (
              <button
                onClick={signInWithPassword}
                disabled={!email || !password || busy}
                className={primaryBtnCls}
              >
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            )}

            {mode === 'signup' && (
              <button
                onClick={signUpWithPassword}
                disabled={!email || !password || busy}
                className={primaryBtnCls}
              >
                {busy ? 'Creating…' : 'Create account'}
              </button>
            )}

            {mode === 'magic' && (
              <button
                onClick={sendMagicLink}
                disabled={!email || busy}
                className={primaryBtnCls}
              >
                {busy ? 'Sending…' : 'Send sign-in link'}
              </button>
            )}

            {notice && (
              <p className="rounded-xl bg-emerald-500/15 p-4 text-emerald-300">{notice}</p>
            )}
            {err && <p className="text-sm text-red-400">{err}</p>}

            <div className="flex flex-col gap-2 pt-2">
              {mode !== 'signin' && (
                <button onClick={() => { setMode('signin'); resetMessages(); }} className={linkBtnCls}>
                  Sign in with password
                </button>
              )}
              {mode !== 'signup' && (
                <button onClick={() => { setMode('signup'); resetMessages(); }} className={linkBtnCls}>
                  New judge? Create an account
                </button>
              )}
              {mode !== 'magic' && (
                <button onClick={() => { setMode('magic'); resetMessages(); }} className={linkBtnCls}>
                  Email me a sign-in link instead
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
