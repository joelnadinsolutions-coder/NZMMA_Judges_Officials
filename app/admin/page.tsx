'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSupabase } from '@/lib/supabase/client';
import { isApprovedOfficial, Loading, NotAuthorized } from '@/components/officials';

export default function AdminHub() {
  const supabase = getSupabase();
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [pending, setPending] = useState(0);
  const [events, setEvents] = useState(0);

  useEffect(() => {
    (async () => {
      const ok = await isApprovedOfficial(supabase);
      setAuthorized(ok);
      if (!ok) return;
      const { count: pc } = await supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending');
      setPending(pc ?? 0);
      const { count: ec } = await supabase
        .from('events')
        .select('id', { count: 'exact', head: true });
      setEvents(ec ?? 0);
    })();
  }, [supabase]);

  if (authorized === null) return <Loading />;
  if (!authorized) return <NotAuthorized />;

  return (
    <div className="mx-auto min-h-dvh max-w-md space-y-4 bg-slate-950 px-4 py-6 text-slate-50">
      <header>
        <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">
          NZMMAF · Officials
        </p>
        <h1 className="mt-1 text-2xl font-black">Dashboard</h1>
      </header>

      <Link
        href="/admin/approvals"
        className="flex items-center justify-between rounded-2xl bg-slate-900 p-5"
      >
        <span>
          <span className="block text-lg font-bold">User approvals</span>
          <span className="text-sm text-slate-400">Approve judges and set roles</span>
        </span>
        {pending > 0 ? (
          <span className="rounded-full bg-amber-500 px-3 py-1 text-sm font-black text-slate-950">
            {pending}
          </span>
        ) : (
          <span className="text-slate-600">›</span>
        )}
      </Link>

      <Link
        href="/admin/events"
        className="flex items-center justify-between rounded-2xl bg-slate-900 p-5"
      >
        <span>
          <span className="block text-lg font-bold">Events &amp; bouts</span>
          <span className="text-sm text-slate-400">Create bouts, assign judges, run rounds</span>
        </span>
        <span className="text-slate-500">{events}</span>
      </Link>
    </div>
  );
}
