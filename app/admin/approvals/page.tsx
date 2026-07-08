'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { getSupabase } from '@/lib/supabase/client';
import { isApprovedOfficial, Loading, NotAuthorized } from '@/components/officials';

type Role = 'judge' | 'official' | 'admin';
type Status = 'pending' | 'approved' | 'suspended';
interface Profile {
  id: string;
  full_name: string;
  email: string | null;
  role: Role;
  status: Status;
  region: string | null;
}

export default function ApprovalsPage() {
  const supabase = getSupabase();
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name, email, role, status, region')
      .order('created_at', { ascending: false });
    setProfiles((data ?? []) as Profile[]);
  }, [supabase]);

  useEffect(() => {
    (async () => {
      const ok = await isApprovedOfficial(supabase);
      setAuthorized(ok);
      if (ok) await load();
    })();
  }, [supabase, load]);

  async function patch(id: string, change: Partial<Profile>) {
    if (busy) return;
    setBusy(true);
    await supabase.from('profiles').update(change).eq('id', id);
    await load();
    setBusy(false);
  }

  if (authorized === null) return <Loading />;
  if (!authorized) return <NotAuthorized />;

  const pending = profiles.filter((p) => p.status === 'pending');
  const active = profiles.filter((p) => p.status !== 'pending');

  return (
    <div className="mx-auto min-h-dvh max-w-md space-y-5 bg-slate-950 px-4 py-6 text-slate-50">
      <header className="flex items-center gap-3">
        <Link href="/admin" className="text-slate-500">
          ‹
        </Link>
        <h1 className="text-2xl font-black">User approvals</h1>
      </header>

      <section className="space-y-2">
        <h2 className="text-sm font-bold uppercase tracking-widest text-amber-300">
          Pending ({pending.length})
        </h2>
        {pending.length === 0 && <p className="text-sm text-slate-500">Nothing waiting.</p>}
        {pending.map((p) => (
          <ProfileRow key={p.id} profile={p} busy={busy} onPatch={patch} />
        ))}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-bold uppercase tracking-widest text-slate-400">
          Active ({active.length})
        </h2>
        {active.map((p) => (
          <ProfileRow key={p.id} profile={p} busy={busy} onPatch={patch} />
        ))}
      </section>
    </div>
  );
}

function ProfileRow({
  profile,
  busy,
  onPatch,
}: {
  profile: Profile;
  busy: boolean;
  onPatch: (id: string, change: Partial<Profile>) => void;
}) {
  const roles: Role[] = ['judge', 'official', 'admin'];
  const [name, setName] = useState(profile.full_name);
  const nameDirty = name.trim() !== profile.full_name && name.trim().length > 0;
  return (
    <div className="space-y-3 rounded-2xl bg-slate-900 p-4">
      <div className="flex items-center justify-between gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-0 flex-1 rounded-lg bg-slate-800 px-3 py-2 font-bold text-slate-100"
        />
        <StatusBadge status={profile.status} />
      </div>
      {profile.email && (
        <p className="-mt-1 truncate text-xs text-slate-500">{profile.email}</p>
      )}
      {nameDirty && (
        <button
          onClick={() => onPatch(profile.id, { full_name: name.trim() })}
          disabled={busy}
          className="h-9 w-full rounded-lg bg-slate-50 text-sm font-bold text-slate-950 disabled:opacity-40"
        >
          Save name
        </button>
      )}

      <div className="flex flex-wrap gap-2">
        {profile.status !== 'approved' && (
          <button
            onClick={() => onPatch(profile.id, { status: 'approved' })}
            disabled={busy}
            className="h-9 rounded-lg bg-emerald-500 px-3 text-sm font-bold text-white disabled:opacity-40"
          >
            Approve
          </button>
        )}
        {profile.status !== 'suspended' && (
          <button
            onClick={() => onPatch(profile.id, { status: 'suspended' })}
            disabled={busy}
            className="h-9 rounded-lg bg-red-600/80 px-3 text-sm font-bold text-white disabled:opacity-40"
          >
            Suspend
          </button>
        )}
      </div>

      <div>
        <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">Role</p>
        <div className="flex gap-1">
          {roles.map((r) => (
            <button
              key={r}
              onClick={() => onPatch(profile.id, { role: r })}
              disabled={busy || profile.role === r}
              className={`h-9 flex-1 rounded-lg text-xs font-bold uppercase transition ${
                profile.role === r ? 'bg-slate-50 text-slate-950' : 'bg-slate-800 text-slate-300'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const cls =
    status === 'approved'
      ? 'bg-emerald-500/15 text-emerald-300'
      : status === 'pending'
      ? 'bg-amber-500/15 text-amber-300'
      : 'bg-red-500/15 text-red-300';
  return (
    <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold uppercase ${cls}`}>
      {status}
    </span>
  );
}
