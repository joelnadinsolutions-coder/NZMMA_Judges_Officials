'use client';

import { useCallback, useEffect, useState } from 'react';
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
  archived_at: string | null;
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
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(async () => {
    const [{ data: ev }, { data: fi }, { data: pr }, { data: fj }] = await Promise.all([
      supabase
        .from('events')
        .select('id, name, event_date, region, is_live, archived_at')
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

  async function createFight(eventId: string, data: NewBout) {
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

  async function setArchived(eventId: string, archived: boolean) {
    if (busy) return;
    setBusy(true);
    await supabase
      .from('events')
      .update({ archived_at: archived ? new Date().toISOString() : null, is_live: false })
      .eq('id', eventId);
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

  const q = search.trim().toLowerCase();
  const matches = (ev: EventRow) => !q || ev.name.toLowerCase().includes(q);
  const active = events.filter((ev) => !ev.archived_at && matches(ev));
  const archived = events.filter((ev) => ev.archived_at && matches(ev));
  const eventFights = (eventId: string) => fights.filter((f) => f.event_id === eventId);
  // Archiving unlocks once every bout on the card is finished one way or the other.
  const canArchive = (eventId: string) => {
    const fs = eventFights(eventId);
    return fs.length > 0 && fs.every((f) => f.state === 'completed' || f.state === 'cancelled');
  };

  const renderEvent = (ev: EventRow, defaultOpen: boolean) => (
    <EventSection
      key={ev.id}
      event={ev}
      defaultOpen={defaultOpen}
      boutCount={eventFights(ev.id).length}
      canArchive={canArchive(ev.id)}
      busy={busy}
      onToggleLive={() => toggleLive(ev.id, ev.is_live)}
      onArchive={() => setArchived(ev.id, !ev.archived_at)}
    >
      {eventFights(ev.id).map((f) => (
        <FightCard
          key={f.id}
          fight={f}
          judges={judges}
          assigned={assignments[f.id] ?? []}
          busy={busy}
          onToggle={toggleAssign}
        />
      ))}

      <CreateFight onCreate={(data) => createFight(ev.id, data)} busy={busy} />
    </EventSection>
  );

  return (
    <div className="mx-auto min-h-dvh max-w-md space-y-5 bg-slate-950 px-4 py-6 text-slate-50">
      <header className="flex items-center gap-3">
        <Link href="/admin" className="text-slate-500">
          ‹
        </Link>
        <h1 className="text-2xl font-black">Events &amp; bouts</h1>
      </header>

      <CreateEvent onCreate={createEvent} busy={busy} />

      {events.length > 0 && (
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search events"
          className="h-11 w-full rounded-xl bg-slate-900 px-4 text-sm text-slate-100 ring-1 ring-slate-800 placeholder:text-slate-600"
        />
      )}

      {events.length === 0 && <p className="text-sm text-slate-500">No events yet.</p>}
      {events.length > 0 && active.length === 0 && archived.length === 0 && (
        <p className="text-sm text-slate-500">No events match your search.</p>
      )}

      {active.map((ev) => renderEvent(ev, ev.is_live || active.length === 1))}

      {archived.length > 0 && (
        <section className="space-y-3">
          <button
            onClick={() => setShowArchived((s) => !s)}
            className="text-sm font-semibold text-slate-400"
          >
            {showArchived ? '▾' : '▸'} Archived events ({archived.length})
          </button>
          {showArchived && archived.map((ev) => renderEvent(ev, false))}
        </section>
      )}
    </div>
  );
}

// Collapsible event section: several events can run on one night, so each
// folds down to a single header row until opened.
function EventSection({
  event,
  defaultOpen,
  boutCount,
  canArchive,
  busy,
  onToggleLive,
  onArchive,
  children,
}: {
  event: EventRow;
  defaultOpen: boolean;
  boutCount: number;
  canArchive: boolean;
  busy: boolean;
  onToggleLive: () => void;
  onArchive: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const isArchived = Boolean(event.archived_at);

  return (
    <section className="space-y-3 rounded-2xl bg-slate-900 p-4">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setOpen((o) => !o)}
          className="shrink-0 px-1 text-lg text-slate-400"
          aria-label={open ? `Collapse ${event.name}` : `Expand ${event.name}`}
        >
          {open ? '▾' : '▸'}
        </button>
        <button onClick={() => setOpen((o) => !o)} className="min-w-0 flex-1 text-left">
          <h2 className="truncate text-lg font-black">{event.name}</h2>
          <p className="text-xs text-slate-400">
            {event.event_date}
            {event.region ? ` · ${event.region}` : ''} · {boutCount} bout
            {boutCount === 1 ? '' : 's'}
          </p>
        </button>
        {isArchived ? (
          <span className="shrink-0 rounded-full bg-slate-800 px-3 py-1 text-xs font-bold uppercase tracking-widest text-slate-500">
            Archived
          </span>
        ) : (
          <button
            onClick={onToggleLive}
            disabled={busy}
            className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-widest disabled:opacity-40 ${
              event.is_live ? 'bg-emerald-500 text-white' : 'bg-slate-800 text-slate-400'
            }`}
          >
            {event.is_live ? '● Live' : 'Go live'}
          </button>
        )}
      </div>

      {open && (
        <>
          <Link
            href={`/admin/events/${event.id}`}
            className="block h-10 rounded-lg bg-slate-800 text-center text-xs font-bold leading-10 text-slate-200"
          >
            Open run sheet ›
          </Link>
          {children}
          {isArchived ? (
            <button
              onClick={onArchive}
              disabled={busy}
              className="h-10 w-full rounded-lg bg-slate-800 text-xs font-bold text-slate-300 disabled:opacity-40"
            >
              Unarchive event
            </button>
          ) : (
            canArchive && (
              <button
                onClick={onArchive}
                disabled={busy}
                className="h-10 w-full rounded-lg bg-slate-800 text-xs font-bold text-slate-300 disabled:opacity-40"
              >
                Archive event (all bouts finished)
              </button>
            )
          )}
        </>
      )}
    </section>
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
  const [copied, setCopied] = useState(false);

  async function copyJudgeLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/judge/${fight.id}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (old browser, insecure context): do nothing.
    }
  }

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

      <div className="mt-2 flex items-center gap-4">
        <button
          onClick={() => setShowJudges((s) => !s)}
          className="text-xs font-semibold text-slate-400"
        >
          {showJudges ? 'Hide judges' : 'Assign judges'}
        </button>
        <button
          onClick={copyJudgeLink}
          className={`text-xs font-semibold ${copied ? 'text-emerald-300' : 'text-slate-400'}`}
        >
          {copied ? 'Link copied ✓' : 'Copy judge link'}
        </button>
      </div>

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
