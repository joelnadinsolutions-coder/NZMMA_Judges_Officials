'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { getSupabase } from '@/lib/supabase/client';
import { isApprovedOfficial, Loading, NotAuthorized } from '@/components/officials';
import { CreateFight, type NewBout } from '@/components/bouts';

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

// Event run sheet: every bout with its full judge panel in one view, drag
// reordering of the running order, adding bouts, and quick judge swaps for
// conflicts at a live event.
export default function EventDetailPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = use(params);
  const supabase = getSupabase();
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [event, setEvent] = useState<EventRow | null>(null);
  const [fights, setFights] = useState<FightRow[]>([]);
  const [judges, setJudges] = useState<JudgeRow[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [reorderError, setReorderError] = useState<string | null>(null);
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

  // Persist a dragged order as bout numbers 1..n. bout_order is unique per
  // event, so pass one goes through temporary out-of-range values.
  async function saveOrder(ids: string[]) {
    if (busy) return;
    setBusy(true);
    setReorderError(null);
    // Phase 1 parks every bout at a temporary out-of-range number so phase 2
    // can assign 1..n without tripping the per-event unique constraint. If
    // any write fails we stop, reload to show the real state, and keep the
    // reorder open so the official can retry rather than leaving bouts
    // stranded at 10000+ silently.
    try {
      for (let i = 0; i < ids.length; i++) {
        const { error } = await supabase.from('fights').update({ bout_order: 10000 + i }).eq('id', ids[i]);
        if (error) throw error;
      }
      for (let i = 0; i < ids.length; i++) {
        const { error } = await supabase.from('fights').update({ bout_order: i + 1 }).eq('id', ids[i]);
        if (error) throw error;
      }
      await load();
      setReordering(false);
    } catch {
      await load();
      setReorderError('Could not save the new order. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function createFight(data: NewBout) {
    if (busy) return;
    setBusy(true);
    const nextOrder = Math.max(0, ...fights.map((f) => f.bout_order)) + 1;
    const { data: created } = await supabase
      .from('fights')
      .insert({ event_id: eventId, bout_order: nextOrder, ...data })
      .select('id')
      .single();
    if (created) {
      // Create the round rows (all pending; the official opens R1 at bout start).
      const rows = Array.from({ length: data.scheduled_rounds }, (_, i) => ({
        fight_id: created.id,
        round_number: i + 1,
      }));
      await supabase.from('rounds').insert(rows);
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

      {fights.length === 0 && <p className="text-sm text-slate-500">No bouts in this event yet.</p>}

      {reordering ? (
        <ReorderList
          fights={fights}
          busy={busy}
          error={reorderError}
          onSave={saveOrder}
          onCancel={() => {
            setReorderError(null);
            setReordering(false);
          }}
        />
      ) : (
        <>
          {fights.length > 1 && (
            <button
              onClick={() => setReordering(true)}
              disabled={busy}
              className="h-10 w-full rounded-lg bg-slate-800 text-xs font-bold text-slate-300 disabled:opacity-40"
            >
              ⇅ Reorder bouts
            </button>
          )}

          {fights.map((f) => (
            <BoutPanel
              key={f.id}
              fight={f}
              judges={judges}
              assigned={assignments[f.id] ?? []}
              busy={busy}
              onToggle={toggleAssign}
            />
          ))}

          <CreateFight onCreate={createFight} busy={busy} />
        </>
      )}
    </div>
  );
}

// Compact fixed-height rows dragged by the ≡ handle. Pointer events cover
// both touch and mouse; the handle is touch-action none so the page does not
// scroll while dragging.
const ROW_PX = 56;

function ReorderList({
  fights,
  busy,
  error,
  onSave,
  onCancel,
}: {
  fights: FightRow[];
  busy: boolean;
  error: string | null;
  onSave: (ids: string[]) => void;
  onCancel: () => void;
}) {
  const [order, setOrder] = useState(() => fights.map((f) => f.id));
  const [dragId, setDragId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const byId = new Map(fights.map((f) => [f.id, f]));
  const dirty = order.some((id, i) => fights[i]?.id !== id || byId.get(id)?.bout_order !== i + 1);

  function onPointerMove(e: React.PointerEvent) {
    if (!dragId || !listRef.current) return;
    const top = listRef.current.getBoundingClientRect().top;
    let idx = Math.floor((e.clientY - top) / ROW_PX);
    idx = Math.max(0, Math.min(order.length - 1, idx));
    const cur = order.indexOf(dragId);
    if (idx !== cur) {
      const next = [...order];
      next.splice(cur, 1);
      next.splice(idx, 0, dragId);
      setOrder(next);
    }
  }

  return (
    <section className="space-y-3 rounded-2xl bg-slate-900 p-3">
      <p className="text-xs text-slate-400">Drag the ≡ handle to set the running order.</p>
      {error && (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-300 ring-1 ring-red-500/30">
          {error}
        </p>
      )}
      <div ref={listRef} onPointerMove={onPointerMove} onPointerUp={() => setDragId(null)}>
        {order.map((id, i) => {
          const f = byId.get(id);
          if (!f) return null;
          return (
            <div
              key={id}
              style={{ height: ROW_PX }}
              className={`flex items-center gap-3 border-b border-slate-800 px-2 last:border-b-0 ${
                dragId === id ? 'rounded-lg bg-slate-700/60' : ''
              }`}
            >
              <span className="w-6 text-lg font-black text-slate-500">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-sm font-bold">
                {f.fighter_a_name} <span className="text-slate-500">vs</span> {f.fighter_b_name}
              </span>
              <button
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setDragId(id);
                }}
                className="touch-none px-3 py-2 text-xl text-slate-400"
                aria-label={`Drag to reorder bout ${f.fighter_a_name} vs ${f.fighter_b_name}`}
              >
                ≡
              </button>
            </div>
          );
        })}
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => onSave(order)}
          disabled={busy || !dirty}
          className="h-11 flex-1 rounded-xl bg-slate-50 text-sm font-bold text-slate-950 disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save order'}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="h-11 rounded-xl bg-slate-800 px-4 text-sm font-bold text-slate-300 disabled:opacity-40"
        >
          Cancel
        </button>
      </div>
    </section>
  );
}

function BoutPanel({
  fight,
  judges,
  assigned,
  busy,
  onToggle,
}: {
  fight: FightRow;
  judges: JudgeRow[];
  assigned: string[];
  busy: boolean;
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
