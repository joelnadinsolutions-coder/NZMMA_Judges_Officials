'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { getSupabase } from '@/lib/supabase/client';
import { isApprovedOfficial, Loading, NotAuthorized } from '@/components/officials';

interface EventRow {
  id: string;
  name: string;
  event_date: string;
  region: string | null;
  is_live: boolean;
}
type FightState = 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
interface FightRow {
  id: string;
  bout_order: number;
  weight_class: string;
  fighter_a_name: string;
  fighter_b_name: string;
  scheduled_rounds: number;
  state: FightState;
}
interface JudgeRow {
  id: string;
  name: string;
}

// Event run sheet: every bout with its full judge panel in one view, plus
// bout reordering and quick judge swaps for conflicts at a live event.
export default function EventDetailPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = use(params);
  const supabase = getSupabase();
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [event, setEvent] = useState<EventRow | null>(null);
  const [fights, setFights] = useState<FightRow[]>([]);
  const [judges, setJudges] = useState<JudgeRow[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    const [{ data: ev }, { data: fi }, { data: pr }, { data: fj }] = await Promise.all([
      supabase
        .from('events')
        .select('id, name, event_date, region, is_live')
        .eq('id', eventId)
        .maybeSingle(),
      supabase
        .from('fights')
        .select('id, bout_order, weight_class, fighter_a_name, fighter_b_name, scheduled_rounds, state')
        .eq('event_id', eventId)
        .order('bout_order'),
      supabase.from('profiles').select('id, full_name').eq('status', 'approved'),
      supabase.from('fight_judges').select('fight_id, judge_id'),
    ]);
    if (!ev) {
      setNotFound(true);
      return;
    }
    setEvent(ev as EventRow);
    setFights((fi ?? []) as FightRow[]);
    setJudges((pr ?? []).map((p) => ({ id: p.id, name: p.full_name })));
    const map: Record<string, string[]> = {};
    (fj ?? []).forEach((row) => {
      (map[row.fight_id] ??= []).push(row.judge_id);
    });
    setAssignments(map);
  }, [supabase, eventId]);

  useEffect(() => {
    (async () => {
      const ok = await isApprovedOfficial(supabase);
      setAuthorized(ok);
      if (ok) await load();
    })();
  }, [supabase, load]);

  // Swap this bout with its neighbour. bout_order has a unique constraint
  // per event, so the swap goes through a temporary out-of-range value.
  async function moveBout(index: number, dir: -1 | 1) {
    if (busy) return;
    const a = fights[index];
    const b = fights[index + dir];
    if (!a || !b) return;
    setBusy(true);
    const temp = 10000 + a.bout_order;
    await supabase.from('fights').update({ bout_order: temp }).eq('id', a.id);
    await supabase.from('fights').update({ bout_order: a.bout_order }).eq('id', b.id);
    await supabase.from('fights').update({ bout_order: b.bout_order }).eq('id', a.id);
    await load();
    setBusy(false);
  }

  // Close gaps so bouts read 1..n after deletions or reshuffles. Two passes
  // for the same unique-constraint reason as moveBout.
  async function renumber() {
    if (busy) return;
    setBusy(true);
    for (let i = 0; i < fights.length; i++) {
      await supabase.from('fights').update({ bout_order: 10000 + i }).eq('id', fights[i].id);
    }
    for (let i = 0; i < fights.length; i++) {
      await supabase.from('fights').update({ bout_order: i + 1 }).eq('id', fights[i].id);
    }
    await load();
    setBusy(false);
  }

  async function toggleAssign(fightId: string, judgeId: string, assigned: boolean) {
    if (busy) return;
    setBusy(true);
    if (assigned) {
      await supabase.from('fight_judges').delete().eq('fight_id', fightId).eq('judge_id', judgeId);
    } else {
      await supabase.from('fight_judges').insert({ fight_id: fightId, judge_id: judgeId });
    }
    await load();
    setBusy(false);
  }

  if (authorized === null) return <Loading />;
  if (!authorized) return <NotAuthorized />;
  if (notFound) {
    return (
      <div className="grid min-h-dvh place-items-center bg-slate-950 px-6 text-center text-slate-300">
        <p className="text-lg font-semibold">Event not found.</p>
      </div>
    );
  }
  if (!event) return <Loading />;

  const needsRenumber = fights.some((f, i) => f.bout_order !== i + 1);

  return (
    <div className="mx-auto min-h-dvh max-w-md space-y-4 bg-slate-950 px-4 py-6 text-slate-50">
      <header className="flex items-center gap-3">
        <Link href="/admin/events" className="text-slate-500">
          ‹
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-black">{event.name}</h1>
          <p className="text-xs text-slate-400">
            {event.event_date}
            {event.region ? ` · ${event.region}` : ''}
          </p>
        </div>
        {event.is_live && (
          <span className="shrink-0 rounded-full bg-emerald-500 px-3 py-1 text-xs font-bold uppercase tracking-widest text-white">
            ● Live
          </span>
        )}
      </header>

      {fights.length === 0 && (
        <p className="text-sm text-slate-500">No bouts in this event yet. Add them from the events list.</p>
      )}

      {needsRenumber && (
        <button
          onClick={renumber}
          disabled={busy}
          className="h-10 w-full rounded-lg bg-slate-800 text-xs font-bold text-slate-300 disabled:opacity-40"
        >
          Renumber bouts 1–{fights.length}
        </button>
      )}

      {fights.map((f, i) => (
        <BoutPanel
          key={f.id}
          fight={f}
          judges={judges}
          assigned={assignments[f.id] ?? []}
          busy={busy}
          isFirst={i === 0}
          isLast={i === fights.length - 1}
          onMoveUp={() => moveBout(i, -1)}
          onMoveDown={() => moveBout(i, 1)}
          onToggle={toggleAssign}
        />
      ))}
    </div>
  );
}

function BoutPanel({
  fight,
  judges,
  assigned,
  busy,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
  onToggle,
}: {
  fight: FightRow;
  judges: JudgeRow[];
  assigned: string[];
  busy: boolean;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onToggle: (fightId: string, judgeId: string, assigned: boolean) => void;
}) {
  const [adding, setAdding] = useState(false);
  const assignedJudges = assigned
    .map((id) => judges.find((j) => j.id === id))
    .filter((j): j is JudgeRow => Boolean(j));
  const available = judges.filter((j) => !assigned.includes(j.id));
  const stateCls =
    fight.state === 'in_progress'
      ? 'bg-emerald-500/15 text-emerald-300'
      : fight.state === 'completed'
      ? 'bg-slate-700 text-slate-300'
      : fight.state === 'cancelled'
      ? 'bg-red-500/15 text-red-300'
      : 'bg-slate-800 text-slate-500';

  return (
    <section className="rounded-2xl bg-slate-900 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-lg font-black text-slate-500">#{fight.bout_order}</span>
            <p className="truncate font-bold">
              {fight.fighter_a_name} <span className="text-slate-500">vs</span> {fight.fighter_b_name}
            </p>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest ${stateCls}`}
            >
              {fight.state.replace('_', ' ')}
            </span>
          </div>
          <p className="text-xs text-slate-400">
            {fight.weight_class} · {fight.scheduled_rounds} rounds
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            onClick={onMoveUp}
            disabled={busy || isFirst}
            className="h-9 w-9 rounded-lg bg-slate-800 text-sm font-black text-slate-300 disabled:opacity-30"
            aria-label="Move bout up"
          >
            ▲
          </button>
          <button
            onClick={onMoveDown}
            disabled={busy || isLast}
            className="h-9 w-9 rounded-lg bg-slate-800 text-sm font-black text-slate-300 disabled:opacity-30"
            aria-label="Move bout down"
          >
            ▼
          </button>
        </div>
      </div>

      <div className="mt-3">
        <p className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-500">
          Judges ({assignedJudges.length})
        </p>
        {assignedJudges.length === 0 && (
          <p className="text-xs text-slate-500">No judges assigned.</p>
        )}
        <div className="flex flex-wrap gap-1.5">
          {assignedJudges.map((j) => (
            <span
              key={j.id}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-500/15 px-2.5 py-1.5 text-sm font-semibold text-emerald-200"
            >
              <span className="max-w-32 truncate">{j.name}</span>
              <button
                onClick={() => onToggle(fight.id, j.id, true)}
                disabled={busy}
                className="text-emerald-300/70 disabled:opacity-40"
                aria-label={`Remove ${j.name}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>

        {adding ? (
          <div className="mt-2 space-y-1">
            {available.length === 0 && (
              <p className="text-xs text-slate-500">Every approved judge is already on this bout.</p>
            )}
            {available.map((j) => (
              <button
                key={j.id}
                onClick={() => onToggle(fight.id, j.id, false)}
                disabled={busy}
                className="flex h-10 w-full items-center justify-between rounded-lg bg-slate-800 px-3 text-sm font-semibold text-slate-300 disabled:opacity-40"
              >
                <span className="truncate">{j.name}</span>
                <span>add</span>
              </button>
            ))}
            <button onClick={() => setAdding(false)} className="text-xs font-semibold text-slate-500">
              Done
            </button>
          </div>
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="mt-2 text-xs font-semibold text-slate-400"
          >
            + Add judge
          </button>
        )}
      </div>

      <Link
        href={`/official/${fight.id}`}
        className="mt-3 block h-10 rounded-lg bg-emerald-500 text-center text-xs font-bold leading-10 text-white"
      >
        Control bout
      </Link>
    </section>
  );
}
