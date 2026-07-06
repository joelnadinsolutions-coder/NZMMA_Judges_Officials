'use client';

import { useCallback, useEffect, useState } from 'react';
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
  event_id: string;
  bout_order: number;
  weight_class: string;
  fighter_a_name: string;
  fighter_b_name: string;
  scheduled_rounds: number;
  state: FightState;
  result_method: string | null;
  result_winner: 'a' | 'b' | 'draw' | null;
  result_round: number | null;
}
interface JudgeRow {
  id: string;
  name: string;
}

export default function EventsPage() {
  const supabase = getSupabase();
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [fights, setFights] = useState<FightRow[]>([]);
  const [judges, setJudges] = useState<JudgeRow[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string[]>>({}); // fightId -> judgeIds
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [{ data: ev }, { data: fi }, { data: pr }, { data: fj }] = await Promise.all([
      supabase
        .from('events')
        .select('id, name, event_date, region, is_live')
        .order('event_date', { ascending: false }),
      supabase
        .from('fights')
        .select(
          'id, event_id, bout_order, weight_class, fighter_a_name, fighter_b_name, scheduled_rounds, state, result_method, result_winner, result_round',
        )
        .order('bout_order'),
      supabase.from('profiles').select('id, full_name').eq('status', 'approved'),
      supabase.from('fight_judges').select('fight_id, judge_id'),
    ]);
    setEvents((ev ?? []) as EventRow[]);
    setFights((fi ?? []) as FightRow[]);
    setJudges((pr ?? []).map((p) => ({ id: p.id, name: p.full_name })));
    const map: Record<string, string[]> = {};
    (fj ?? []).forEach((row) => {
      (map[row.fight_id] ??= []).push(row.judge_id);
    });
    setAssignments(map);
  }, [supabase]);

  useEffect(() => {
    (async () => {
      const ok = await isApprovedOfficial(supabase);
      setAuthorized(ok);
      if (!ok) return;
      const {
        data: { user },
      } = await supabase.auth.getUser();
      setUserId(user?.id ?? null);
      await load();
    })();
  }, [supabase, load]);

  async function createEvent(name: string, date: string, region: string) {
    if (busy) return;
    setBusy(true);
    await supabase
      .from('events')
      .insert({ name, event_date: date, region: region || null, created_by: userId });
    await load();
    setBusy(false);
  }

  async function createFight(
    eventId: string,
    data: {
      fighter_a_name: string;
      fighter_b_name: string;
      weight_class: string;
      scheduled_rounds: number;
      round_minutes: number;
    },
  ) {
    if (busy) return;
    setBusy(true);
    const nextOrder =
      Math.max(0, ...fights.filter((f) => f.event_id === eventId).map((f) => f.bout_order)) + 1;
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

  async function toggleLive(eventId: string, isLive: boolean) {
    if (busy) return;
    setBusy(true);
    await supabase.from('events').update({ is_live: !isLive }).eq('id', eventId);
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

  return (
    <div className="mx-auto min-h-dvh max-w-md space-y-5 bg-slate-950 px-4 py-6 text-slate-50">
      <header className="flex items-center gap-3">
        <Link href="/admin" className="text-slate-500">
          ‹
        </Link>
        <h1 className="text-2xl font-black">Events &amp; bouts</h1>
      </header>

      <CreateEvent onCreate={createEvent} busy={busy} />

      {events.length === 0 && <p className="text-sm text-slate-500">No events yet.</p>}

      {events.map((ev) => (
        <section key={ev.id} className="space-y-3 rounded-2xl bg-slate-900 p-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-lg font-black">{ev.name}</h2>
              <p className="text-xs text-slate-400">
                {ev.event_date}
                {ev.region ? ` · ${ev.region}` : ''}
              </p>
            </div>
            <button
              onClick={() => toggleLive(ev.id, ev.is_live)}
              disabled={busy}
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-widest disabled:opacity-40 ${
                ev.is_live ? 'bg-emerald-500 text-white' : 'bg-slate-800 text-slate-400'
              }`}
            >
              {ev.is_live ? '● Live' : 'Go live'}
            </button>
          </div>

          {fights
            .filter((f) => f.event_id === ev.id)
            .map((f) => (
              <FightCard
                key={f.id}
                fight={f}
                judges={judges}
                assigned={assignments[f.id] ?? []}
                busy={busy}
                onToggle={toggleAssign}
              />
            ))}

          <CreateFight eventId={ev.id} onCreate={createFight} busy={busy} />
        </section>
      ))}
    </div>
  );
}

function CreateEvent({
  onCreate,
  busy,
}: {
  onCreate: (name: string, date: string, region: string) => void;
  busy: boolean;
}) {
  const [name, setName] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [region, setRegion] = useState('');
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="h-11 w-full rounded-xl bg-slate-800 text-sm font-bold text-slate-200"
      >
        + New event
      </button>
    );
  }
  return (
    <div className="space-y-2 rounded-2xl bg-slate-900 p-4">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Event name"
        className="h-11 w-full rounded-lg bg-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-600"
      />
      <div className="flex gap-2">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="h-11 flex-1 rounded-lg bg-slate-800 px-3 text-sm text-slate-100"
        />
        <input
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          placeholder="Region"
          className="h-11 flex-1 rounded-lg bg-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-600"
        />
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => {
            onCreate(name.trim(), date, region.trim());
            setName('');
            setRegion('');
            setOpen(false);
          }}
          disabled={busy || !name.trim()}
          className="h-10 flex-1 rounded-lg bg-slate-50 text-sm font-bold text-slate-950 disabled:opacity-40"
        >
          Create
        </button>
        <button
          onClick={() => setOpen(false)}
          className="h-10 rounded-lg bg-slate-800 px-4 text-sm font-bold text-slate-300"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function FightCard({
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
  const [showJudges, setShowJudges] = useState(false);
  const stateCls =
    fight.state === 'in_progress'
      ? 'bg-emerald-500/15 text-emerald-300'
      : fight.state === 'completed'
      ? 'bg-slate-700 text-slate-300'
      : fight.state === 'cancelled'
      ? 'bg-red-500/15 text-red-300'
      : 'bg-slate-800 text-slate-500';
  const resultSummary =
    fight.state === 'completed' && fight.result_method
      ? fight.result_method === 'no_contest'
        ? 'No Contest'
        : `${
            fight.result_winner === 'a'
              ? fight.fighter_a_name.split(' ')[0]
              : fight.result_winner === 'b'
              ? fight.fighter_b_name.split(' ')[0]
              : 'Draw'
          } · ${fight.result_method.toUpperCase()}${fight.result_round ? ` R${fight.result_round}` : ''}`
      : null;
  return (
    <div className="rounded-xl bg-slate-950/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="truncate font-bold">
              {fight.fighter_a_name} <span className="text-slate-500">vs</span> {fight.fighter_b_name}
            </p>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest ${stateCls}`}>
              {fight.state.replace('_', ' ')}
            </span>
          </div>
          <p className="text-xs text-slate-400">
            Bout {fight.bout_order} · {fight.weight_class} · {fight.scheduled_rounds} rounds ·{' '}
            {assigned.length} judge{assigned.length === 1 ? '' : 's'}
          </p>
          {resultSummary && <p className="text-xs font-semibold text-emerald-300">{resultSummary}</p>}
        </div>
        <Link
          href={`/official/${fight.id}`}
          className="shrink-0 rounded-lg bg-emerald-500 px-3 py-2 text-xs font-bold text-white"
        >
          Control
        </Link>
      </div>

      <button
        onClick={() => setShowJudges((s) => !s)}
        className="mt-2 text-xs font-semibold text-slate-400"
      >
        {showJudges ? 'Hide judges' : 'Assign judges'}
      </button>

      {showJudges && (
        <div className="mt-2 space-y-1">
          {judges.length === 0 && (
            <p className="text-xs text-slate-500">No approved judges yet.</p>
          )}
          {judges.map((j) => {
            const isOn = assigned.includes(j.id);
            return (
              <button
                key={j.id}
                onClick={() => onToggle(fight.id, j.id, isOn)}
                disabled={busy}
                className={`flex h-10 w-full items-center justify-between rounded-lg px-3 text-sm font-semibold transition ${
                  isOn ? 'bg-emerald-500/20 text-emerald-200' : 'bg-slate-800 text-slate-300'
                }`}
              >
                <span className="truncate">{j.name}</span>
                <span>{isOn ? '✓ assigned' : 'add'}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CreateFight({
  eventId,
  onCreate,
  busy,
}: {
  eventId: string;
  onCreate: (
    eventId: string,
    data: {
      fighter_a_name: string;
      fighter_b_name: string;
      weight_class: string;
      scheduled_rounds: number;
      round_minutes: number;
    },
  ) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [weight, setWeight] = useState('');
  const [rounds, setRounds] = useState(3);
  const [minutes, setMinutes] = useState(5);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="h-10 w-full rounded-lg bg-slate-800 text-sm font-bold text-slate-300"
      >
        + Add bout
      </button>
    );
  }
  return (
    <div className="space-y-2 rounded-xl bg-slate-950/60 p-3">
      <input
        value={a}
        onChange={(e) => setA(e.target.value)}
        placeholder="Fighter A name"
        className="h-10 w-full rounded-lg bg-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-600"
      />
      <input
        value={b}
        onChange={(e) => setB(e.target.value)}
        placeholder="Fighter B name"
        className="h-10 w-full rounded-lg bg-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-600"
      />
      <input
        value={weight}
        onChange={(e) => setWeight(e.target.value)}
        placeholder="Weight class"
        className="h-10 w-full rounded-lg bg-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-600"
      />
      <div className="flex gap-2">
        <Pick label="Rounds" value={rounds} options={[3, 5]} onChange={setRounds} suffix="" />
        <Pick label="Length" value={minutes} options={[3, 5]} onChange={setMinutes} suffix="m" />
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => {
            onCreate(eventId, {
              fighter_a_name: a.trim(),
              fighter_b_name: b.trim(),
              weight_class: weight.trim() || 'Catchweight',
              scheduled_rounds: rounds,
              round_minutes: minutes,
            });
            setA('');
            setB('');
            setWeight('');
            setOpen(false);
          }}
          disabled={busy || !a.trim() || !b.trim()}
          className="h-10 flex-1 rounded-lg bg-slate-50 text-sm font-bold text-slate-950 disabled:opacity-40"
        >
          Create bout
        </button>
        <button
          onClick={() => setOpen(false)}
          className="h-10 rounded-lg bg-slate-800 px-4 text-sm font-bold text-slate-300"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function Pick({
  label,
  value,
  options,
  onChange,
  suffix,
}: {
  label: string;
  value: number;
  options: number[];
  onChange: (v: number) => void;
  suffix: string;
}) {
  return (
    <div className="flex-1">
      <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</p>
      <div className="flex gap-1">
        {options.map((o) => (
          <button
            key={o}
            onClick={() => onChange(o)}
            className={`h-9 flex-1 rounded-lg text-sm font-bold transition ${
              value === o ? 'bg-slate-50 text-slate-950' : 'bg-slate-800 text-slate-300'
            }`}
          >
            {o}
            {suffix}
          </button>
        ))}
      </div>
    </div>
  );
}
