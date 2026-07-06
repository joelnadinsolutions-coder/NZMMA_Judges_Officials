import Link from 'next/link';
import type { SupabaseClient } from '@supabase/supabase-js';

// True only for a signed-in, approved official or admin.
export async function isApprovedOfficial(supabase: SupabaseClient): Promise<boolean> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;
  const { data: me } = await supabase
    .from('profiles')
    .select('role, status')
    .eq('id', user.id)
    .single();
  return !!me && me.status === 'approved' && (me.role === 'official' || me.role === 'admin');
}

export function Loading() {
  return <div className="grid min-h-dvh place-items-center bg-slate-950 text-slate-400">Loading…</div>;
}

export function NotAuthorized() {
  return (
    <div className="grid min-h-dvh place-items-center bg-slate-950 px-6 text-center text-slate-300">
      <div className="max-w-sm space-y-3">
        <p className="text-lg font-semibold">Officials only</p>
        <p className="text-sm text-slate-500">
          You need an approved official or admin account to view this.
        </p>
        <Link
          href="/login"
          className="inline-block rounded-lg bg-slate-800 px-4 py-2 text-sm font-bold text-slate-100"
        >
          Sign in
        </Link>
      </div>
    </div>
  );
}
