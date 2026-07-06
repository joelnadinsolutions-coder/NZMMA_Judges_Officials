'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase/client';

type FightState = 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
type ResultMethod = 'decision' | 'ko' | 'tko' | 'submission' | 'dq' | 'no_contest';
type ResultWinner = 'a' | 'b' | 'draw';

interface Fight {
  id: string;
  fighter_a_name: string;
  fighter_b_name: string;
  fighter_a_corner: string;
  fighter_b_corner: string;
  weight_class: string;
  scheduled_rounds: number;
  current_round: number;
  round_minutes: number;
  is_championship: boolean;
  state: FightState;
  result_method: ResultMethod | null;
  result_winner: ResultWinner | null;
  result_round: number | null;
  result_note: string | null;
}

type RoundState = 'pending' | 'live' | 'locked';
interface Round {
  round_number: number;
  state: RoundState;
  fighter_a_deduction: number;
  fighter_b_deduction: number;
  deduction_note: string | null;
}

interface Judge {
  id: string;
  name: string;
}
interface ScoreRow {
  round_number: number;
  judge_id: string;
  fighter_a_score: number;
  fighter_b_score: number;
  note: string | null;
  margin_tag: 'close' | 'decisive' | null;
}
interface Submission {
  label: string; // J1 / J2 / J3
  short: string; // First L
  full: string;
  score: ScoreRow | null;
}

// "Jay Nadin" -> "Jay N"; falls back to the local part of an email.
function abbrev(name: string): string {
  let n = (name ?? '').trim();
  if (!n) return 'Judge';
  if (n.includes('@')) n = n.split('@')[0];
  const parts = n.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}`;
}

type JudgeResult = 'a' | 'b' | 'draw';

// Combine each judge's winner into the bout decision type (Unified Rules).
// Standard 3-judge panel; degrades sensibly for other counts while testing.
function decisionLabel(results: JudgeResult[], shortA: string, shortB: string): string {
  const n = results.length;
  if (n === 0) return 'No judges assigned';
  const a = results.filter((r) => r === 'a').length;
  const b = results.filter((r) => r === 'b').length;
  const d = results.filter((r) => r === 'draw').length;
  const majority = (n + 1) / 2;

  const win = (who: string, cnt: number, otherWins: number) =>
    cnt === n
      ? `Unanimous decision: ${who}`
      : otherWins === 0
      ? `Majority decision: ${who}`
      : `Split decision: ${who}`;

  if (a > b && a >= majority) return win(shortA, a, b);
  if (b > a && b >= majority) return win(shortB, b, a);
  if (d === n) return 'Draw (unanimous)';
  if (d > a + b) return 'Draw (majority)';
  return 'Draw (split)';
}

// Same majority logic as decisionLabel, but as a plain a/b/draw value for
// prefilling the official's "close bout" winner picker.
function majorityWinner(results: JudgeResult[]): ResultWinner {
  const n = results.length;
  const a = results.filter((r) => r === 'a').length;
  const b = results.filter((r) => r === 'b').length;
  const majority = (n + 1) / 2;
  if (a > b && a >= majority) return 'a';
  if (b > a && b >= majority) return 'b';
  return 'draw';
}

const RESULT_METHOD_LABEL: Record<ResultMethod, string> = {
  decision: 'Decision',
  ko: 'KO',
  tko: 'TKO',
  submission: 'Submission',
  dq: 'DQ',
  no_contest: 'No Contest',
};

export default function OfficialFightPage({ params }: { params: Promise<{ fightId: string }> }) {
  const { fightId } = use(params);
  const supabase = getSupabase();
  const [fight, setFight] = useState<Fight | null>(null);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [judges, setJudges] = useState<Judge[]>([]);
  const [scores, setScores] = useState<ScoreRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    // RLS returns these only to officials/admins.
    const { data: f, error: fErr } = await supabase
      .from('fights')
      .select(
        'id, fighter_a_name, fighter_b_name, fighter_a_corner, fighter_b_corner, weight_class, scheduled_rounds, current_round, round_minutes, is_championship, state, result_method, result_winner, result_round, result_note',
      )
      .eq('id', fightId)
      .single();
    if (fErr || !f) {
      setError('You need an official or admin account to control this bout.');
      return;
    }
    setFight(f as Fight);

    const { data: r } = await supabase
      .from('rounds')
      .select('round_number, state, fighter_a_deduction, fighter_b_deduction, deduction_note')
      .eq('fight_id', fightId)
      .order('round_number');
    setRounds((r ?? []) as Round[]);

    // Assigned judges (names) and every judge's submitted cards.
    const { data: fj } = await supabase
      .from('fight_judges')
      .select('judge_id, seat')
      .eq('fight_id', fightId)
      .order('seat', { ascending: true, nullsFirst: false });
    const ids = (fj ?? []).map((row) => row.judge_id as string);
    const names: Record<string, string> = {};
    if (ids.length) {
      const { data: profs } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', ids);
      profs?.forEach((p) => {
        names[p.id] = p.full_name;
      });
    }
    setJudges(ids.map((id) => ({ id, name: names[id] ?? id.slice(0, 8) })));

    const { data: sc } = await supabase
      .from('scores')
      .select('round_number, judge_id, fighter_a_score, fighter_b_score, note, margin_tag')
      .eq('fight_id', fightId);
    setScores((sc ?? []) as ScoreRow[]);
  }, [supabase, fightId]);

  useEffect(() => {
    load();
    const channel = supabase
      .channel(`official-${fightId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rounds', filter: `fight_id=eq.${fightId}` },
        () => load(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'fights', filter: `id=eq.${fightId}` },
        () => load(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'scores', filter: `fight_id=eq.${fightId}` },
        () => load(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, fightId, load]);

  async function openRound(n: number) {
    if (busy) return;
    setBusy(true);
    // Open this round and make it the current round the judges follow.
    await supabase.from('rounds').update({ state: 'live', started_at: new Date().toISOString() }).eq('fight_id', fightId).eq('round_number', n);
    // First round opened moves the bout out of "scheduled".
    const patch: Partial<Fight> = { current_round: n };
    if (fight?.state === 'scheduled') patch.state = 'in_progress';
    await supabase.from('fights').update(patch).eq('id', fightId);
    await load();
    setBusy(false);
  }

  async function closeBout(method: ResultMethod, winner: ResultWinner | null, atRound: number | null, note: string) {
    if (busy) return;
    setBusy(true);
    const { error: rpcErr } = await supabase.rpc('complete_fight', {
      f_id: fightId,
      method,
      winner,
      at_round: atRound,
      note: note || null,
    });
    if (rpcErr) setError(rpcErr.message);
    await load();
    setBusy(false);
  }

  async function cancelBout(note: string) {
    if (busy) return;
    setBusy(true);
    await supabase
      .from('fights')
      .update({ state: 'cancelled', result_note: note || null })
      .eq('id', fightId);
    await load();
    setBusy(false);
  }

  async function lockRound(n: number) {
    if (busy) return;
    setBusy(true);
    // lock_round() also locks every judge's card for the round.
    const { error: rpcErr } = await supabase.rpc('lock_round', { f_id: fightId, r_num: n });
    if (rpcErr) setError(rpcErr.message);
    await load();
    setBusy(false);
  }

  async function saveDeduction(n: number, a: number, b: number, note: string) {
    if (busy) return;
    setBusy(true);
    await supabase
      .from('rounds')
      .update({ fighter_a_deduction: a, fighter_b_deduction: b, deduction_note: note || null })
      .eq('fight_id', fightId)
      .eq('round_number', n);
    await load();
    setBusy(false);
  }

  async function saveDetails(patch: Partial<Fight>) {
    if (busy) return;
    setBusy(true);
    await supabase.from('fights').update(patch).eq('id', fightId);
    await load();
    setBusy(false);
  }

  async function saveFormat(scheduled_rounds: number, round_minutes: number, is_championship: boolean) {
    if (busy || !fight) return;
    setBusy(true);
    await supabase
      .from('fights')
      .update({ scheduled_rounds, round_minutes, is_championship })
      .eq('id', fightId);
    await load();
    setBusy(false);
  }

  if (error) {
    return (
      <div className="grid min-h-dvh place-items-center bg-slate-950 px-6 text-center text-slate-300">
        <p className="max-w-sm text-lg font-semibold">{error}</p>
      </div>
    );
  }
  if (!fight) {
    return (
      <div className="grid min-h-dvh place-items-center bg-slate-950 text-slate-400">Loading bout…</div>
    );
  }

  // Per-judge running totals = base scores minus that round's deductions.
  const totals = judges.map((j, i) => {
    let a = 0;
    let b = 0;
    for (const r of rounds) {
      const s = scores.find((x) => x.judge_id === j.id && x.round_number === r.round_number);
      if (!s) continue;
      a += s.fighter_a_score - r.fighter_a_deduction;
      b += s.fighter_b_score - r.fighter_b_deduction;
    }
    return { id: j.id, label: `J${i + 1}`, short: abbrev(j.name), a, b };
  });
  const shortA = fight.fighter_a_name.split(' ')[0];
  const shortB = fight.fighter_b_name.split(' ')[0];

  // Each judge's pick, then the combined decision.
  const results: JudgeResult[] = totals.map((t) => (t.a > t.b ? 'a' : t.b > t.a ? 'b' : 'draw'));
  const decision = decisionLabel(results, shortA, shortB);
  const allLocked = rounds.length > 0 && rounds.every((r) => r.state === 'locked');
  const decisionNotes: string[] = [];
  if (judges.length < 3) decisionNotes.push(`${judges.length} of 3 judges`);
  if (!allLocked) decisionNotes.push('provisional, not all rounds locked');
  const suggestedWinner = majorityWinner(results);

  return (
    <div className="mx-auto min-h-dvh max-w-md space-y-4 bg-slate-950 px-4 py-6 text-slate-50">
      <header>
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">
            NZMMAF · Official control
          </p>
          <FightStateBadge state={fight.state} />
        </div>
        <h1 className="mt-1 text-2xl font-black">
          {fight.fighter_a_name} <span className="text-slate-500">vs</span> {fight.fighter_b_name}
        </h1>
      </header>

      {fight.state === 'completed' && (
        <section className="rounded-2xl bg-emerald-500/10 p-4 text-center ring-1 ring-emerald-500/30">
          <p className="text-lg font-black text-emerald-300">
            {fight.result_method === 'no_contest'
              ? 'No Contest'
              : `${fight.result_winner === 'a' ? shortA : fight.result_winner === 'b' ? shortB : 'Draw'} — ${
                  RESULT_METHOD_LABEL[fight.result_method as ResultMethod]
                }${fight.result_round ? ` (R${fight.result_round})` : ''}`}
          </p>
          {fight.result_note && <p className="mt-1 text-sm text-emerald-200/80">{fight.result_note}</p>}
        </section>
      )}

      {fight.state === 'cancelled' && (
        <section className="rounded-2xl bg-red-500/10 p-4 text-center ring-1 ring-red-500/30">
          <p className="text-lg font-black text-red-300">Bout cancelled</p>
          {fight.result_note && <p className="mt-1 text-sm text-red-200/80">{fight.result_note}</p>}
        </section>
      )}

      {judges.length > 0 && (
        <section className="rounded-2xl bg-slate-900 p-3">
          <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">
            Judges
          </p>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
            {judges.map((j, i) => (
              <span key={j.id}>
                <span className="font-black text-slate-400">J{i + 1}</span>{' '}
                <span className="text-slate-100">{abbrev(j.name)}</span>
              </span>
            ))}
          </div>
        </section>
      )}

      <BoutDetailsEditor fight={fight} onSave={saveDetails} busy={busy} />

      <FormatEditor fight={fight} onSave={saveFormat} busy={busy} />

      <section className="space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-widest text-slate-400">Rounds</h2>
        {rounds.map((r) => (
          <RoundControl
            key={r.round_number}
            round={r}
            fighterA={fight.fighter_a_name}
            fighterB={fight.fighter_b_name}
            isCurrent={r.round_number === fight.current_round}
            busy={busy}
            onOpen={() => openRound(r.round_number)}
            onLock={() => lockRound(r.round_number)}
            onSaveDeduction={(a, b, note) => saveDeduction(r.round_number, a, b, note)}
            submissions={judges.map((j, i) => ({
              label: `J${i + 1}`,
              short: abbrev(j.name),
              full: j.name,
              score:
                scores.find((s) => s.judge_id === j.id && s.round_number === r.round_number) ?? null,
            }))}
          />
        ))}
      </section>

      {/* ---- Totals ---- */}
      <section className="space-y-2 rounded-2xl bg-slate-900 p-4">
        <h2 className="text-sm font-bold uppercase tracking-widest text-slate-400">
          Result ({shortA} — {shortB})
        </h2>

        {totals.length > 0 && (
          <div className="rounded-xl bg-slate-950/60 p-3 text-center">
            <p className="text-xl font-black">{decision}</p>
            {decisionNotes.length > 0 && (
              <p className="mt-0.5 text-[11px] uppercase tracking-wide text-slate-500">
                {decisionNotes.join(' · ')}
              </p>
            )}
          </div>
        )}

        {totals.length === 0 && <p className="text-sm text-slate-500">No judges assigned yet.</p>}
        {totals.map((t) => {
          const lead = t.a > t.b ? shortA : t.b > t.a ? shortB : 'even';
          return (
            <div key={t.id} className="flex items-center justify-between text-sm">
              <span className="text-slate-300">
                <span className="font-black text-slate-500">{t.label}</span> {t.short}
              </span>
              <span className="font-bold tabular-nums">
                {t.a} — {t.b}
                <span className="ml-2 text-xs font-semibold uppercase text-emerald-300">{lead}</span>
              </span>
            </div>
          );
        })}
      </section>

      {fight.state !== 'completed' && fight.state !== 'cancelled' && (
        <CloseBout
          shortA={shortA}
          shortB={shortB}
          scheduledRounds={fight.scheduled_rounds}
          suggestedWinner={suggestedWinner}
          busy={busy}
          onClose={closeBout}
          onCancel={cancelBout}
        />
      )}

      <p className="pt-2 text-center text-xs text-slate-500">
        Judges follow the round you open here in real time.
      </p>
    </div>
  );
}

function FightStateBadge({ state }: { state: FightState }) {
  const cls =
    state === 'in_progress'
      ? 'bg-emerald-500/15 text-emerald-300'
      : state === 'completed'
      ? 'bg-slate-700 text-slate-200'
      : state === 'cancelled'
      ? 'bg-red-500/15 text-red-300'
      : 'bg-slate-800 text-slate-400';
  return (
    <span className={`rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-widest ${cls}`}>
      {state.replace('_', ' ')}
    </span>
  );
}

function CloseBout({
  shortA,
  shortB,
  scheduledRounds,
  suggestedWinner,
  busy,
  onClose,
  onCancel,
}: {
  shortA: string;
  shortB: string;
  scheduledRounds: number;
  suggestedWinner: ResultWinner;
  busy: boolean;
  onClose: (method: ResultMethod, winner: ResultWinner | null, atRound: number | null, note: string) => void;
  onCancel: (note: string) => void;
}) {
  const [method, setMethod] = useState<ResultMethod>('decision');
  const [winner, setWinner] = useState<ResultWinner>(suggestedWinner);
  const [atRound, setAtRound] = useState(scheduledRounds);
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelNote, setCancelNote] = useState('');

  const isFinish = method !== 'decision' && method !== 'no_contest';
  const needsWinner = method !== 'no_contest';

  return (
    <section className="space-y-3 rounded-2xl bg-slate-900 p-4">
      <h2 className="text-sm font-bold uppercase tracking-widest text-slate-400">Close bout</h2>

      <div className="grid grid-cols-3 gap-1.5">
        {(Object.keys(RESULT_METHOD_LABEL) as ResultMethod[]).map((m) => (
          <button
            key={m}
            onClick={() => setMethod(m)}
            className={`h-10 rounded-lg text-xs font-bold uppercase transition ${
              method === m ? 'bg-slate-50 text-slate-950' : 'bg-slate-800 text-slate-300'
            }`}
          >
            {RESULT_METHOD_LABEL[m]}
          </button>
        ))}
      </div>

      {needsWinner && (
        <div>
          <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">Winner</p>
          <div className="flex gap-1.5">
            {(
              [
                ['a', shortA],
                ['b', shortB],
                ['draw', 'Draw'],
              ] as [ResultWinner, string][]
            ).map(([w, label]) => (
              <button
                key={w}
                onClick={() => setWinner(w)}
                className={`h-10 flex-1 rounded-lg text-sm font-bold transition ${
                  winner === w ? 'bg-slate-50 text-slate-950' : 'bg-slate-800 text-slate-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {isFinish && (
        <div>
          <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">Round</p>
          <div className="flex gap-1.5">
            {Array.from({ length: scheduledRounds }, (_, i) => i + 1).map((r) => (
              <button
                key={r}
                onClick={() => setAtRound(r)}
                className={`h-10 flex-1 rounded-lg text-sm font-bold transition ${
                  atRound === r ? 'bg-slate-50 text-slate-950' : 'bg-slate-800 text-slate-300'
                }`}
              >
                R{r}
              </button>
            ))}
          </div>
        </div>
      )}

      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional)"
        className="h-10 w-full rounded-lg bg-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-600"
      />

      {confirming ? (
        <div className="space-y-2 rounded-xl bg-slate-950/60 p-3">
          <p className="text-center text-sm text-slate-300">
            Confirm: {method === 'no_contest' ? 'No Contest' : `${winner === 'a' ? shortA : winner === 'b' ? shortB : 'Draw'} by ${RESULT_METHOD_LABEL[method]}`}
            {isFinish ? ` (R${atRound})` : ''}? This locks every round — it cannot be undone.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => {
                onClose(method, needsWinner ? winner : null, isFinish ? atRound : null, note);
                setConfirming(false);
              }}
              disabled={busy}
              className="h-11 flex-1 rounded-xl bg-emerald-500 text-sm font-bold text-white disabled:opacity-40"
            >
              Confirm close
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="h-11 rounded-xl bg-slate-800 px-4 text-sm font-bold text-slate-300"
            >
              Back
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          disabled={busy}
          className="h-12 w-full rounded-xl bg-slate-50 text-sm font-bold text-slate-950 disabled:opacity-40"
        >
          Close bout
        </button>
      )}

      {cancelling ? (
        <div className="space-y-2 rounded-xl bg-red-950/30 p-3 ring-1 ring-red-500/20">
          <input
            value={cancelNote}
            onChange={(e) => setCancelNote(e.target.value)}
            placeholder="Reason (e.g. weigh-in failure, injury)"
            className="h-10 w-full rounded-lg bg-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-600"
          />
          <div className="flex gap-2">
            <button
              onClick={() => {
                onCancel(cancelNote);
                setCancelling(false);
              }}
              disabled={busy}
              className="h-10 flex-1 rounded-lg bg-red-600/80 text-sm font-bold text-white disabled:opacity-40"
            >
              Confirm cancel
            </button>
            <button
              onClick={() => setCancelling(false)}
              className="h-10 rounded-lg bg-slate-800 px-4 text-sm font-bold text-slate-300"
            >
              Back
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setCancelling(true)}
          disabled={busy}
          className="text-xs font-semibold text-slate-500 underline decoration-dotted"
        >
          Cancel this bout instead
        </button>
      )}
    </section>
  );
}

function BoutDetailsEditor({
  fight,
  onSave,
  busy,
}: {
  fight: Fight;
  onSave: (patch: Partial<Fight>) => void;
  busy: boolean;
}) {
  const [aName, setAName] = useState(fight.fighter_a_name);
  const [bName, setBName] = useState(fight.fighter_b_name);
  const [aCorner, setACorner] = useState(fight.fighter_a_corner);
  const [bCorner, setBCorner] = useState(fight.fighter_b_corner);
  const [weight, setWeight] = useState(fight.weight_class);

  const dirty =
    aName !== fight.fighter_a_name ||
    bName !== fight.fighter_b_name ||
    aCorner !== fight.fighter_a_corner ||
    bCorner !== fight.fighter_b_corner ||
    weight !== fight.weight_class;

  return (
    <section className="space-y-3 rounded-2xl bg-slate-900 p-4">
      <h2 className="text-sm font-bold uppercase tracking-widest text-slate-400">Bout details</h2>

      <div className="space-y-2">
        <div className="flex gap-2">
          <input
            value={aName}
            onChange={(e) => setAName(e.target.value)}
            placeholder="Fighter A name"
            className="h-11 flex-1 rounded-lg bg-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-600"
          />
          <CornerToggle value={aCorner} onChange={setACorner} />
        </div>
        <div className="flex gap-2">
          <input
            value={bName}
            onChange={(e) => setBName(e.target.value)}
            placeholder="Fighter B name"
            className="h-11 flex-1 rounded-lg bg-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-600"
          />
          <CornerToggle value={bCorner} onChange={setBCorner} />
        </div>
        <input
          value={weight}
          onChange={(e) => setWeight(e.target.value)}
          placeholder="Weight class"
          className="h-11 w-full rounded-lg bg-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-600"
        />
      </div>

      <button
        onClick={() =>
          onSave({
            fighter_a_name: aName.trim(),
            fighter_b_name: bName.trim(),
            fighter_a_corner: aCorner,
            fighter_b_corner: bCorner,
            weight_class: weight.trim(),
          })
        }
        disabled={!dirty || busy || !aName.trim() || !bName.trim()}
        className="h-11 w-full rounded-xl bg-slate-50 text-sm font-bold text-slate-950 disabled:opacity-40"
      >
        {dirty ? 'Save details' : 'Saved'}
      </button>
    </section>
  );
}

function CornerToggle({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex overflow-hidden rounded-lg">
      <button
        onClick={() => onChange('red')}
        className={`h-11 w-12 text-xs font-bold uppercase ${
          value === 'red' ? 'bg-red-500 text-white' : 'bg-slate-800 text-slate-400'
        }`}
      >
        Red
      </button>
      <button
        onClick={() => onChange('blue')}
        className={`h-11 w-12 text-xs font-bold uppercase ${
          value === 'blue' ? 'bg-sky-500 text-white' : 'bg-slate-800 text-slate-400'
        }`}
      >
        Blue
      </button>
    </div>
  );
}

function FormatEditor({
  fight,
  onSave,
  busy,
}: {
  fight: Fight;
  onSave: (rounds: number, minutes: number, championship: boolean) => void;
  busy: boolean;
}) {
  const [rounds, setRounds] = useState(fight.scheduled_rounds);
  const [minutes, setMinutes] = useState(fight.round_minutes);
  const [champ, setChamp] = useState(fight.is_championship);
  const dirty = rounds !== fight.scheduled_rounds || minutes !== fight.round_minutes || champ !== fight.is_championship;

  return (
    <section className="space-y-3 rounded-2xl bg-slate-900 p-4">
      <h2 className="text-sm font-bold uppercase tracking-widest text-slate-400">Format</h2>
      <div className="flex flex-wrap gap-2">
        <Segmented label="Rounds" value={rounds} options={[3, 5]} onChange={setRounds} suffix="" />
        <Segmented label="Length" value={minutes} options={[3, 5]} onChange={setMinutes} suffix=" min" />
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-300">
        <input type="checkbox" checked={champ} onChange={(e) => setChamp(e.target.checked)} className="h-4 w-4" />
        Championship bout
      </label>
      <button
        onClick={() => onSave(rounds, minutes, champ)}
        disabled={!dirty || busy}
        className="h-11 w-full rounded-xl bg-slate-50 text-sm font-bold text-slate-950 disabled:opacity-40"
      >
        {dirty ? 'Save format' : `${rounds} x ${minutes} min${champ ? ' · championship' : ''}`}
      </button>
    </section>
  );
}

function Segmented({
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
            className={`h-10 flex-1 rounded-lg text-sm font-bold transition ${
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

function RoundControl({
  round,
  fighterA,
  fighterB,
  isCurrent,
  busy,
  onOpen,
  onLock,
  onSaveDeduction,
  submissions,
}: {
  round: Round;
  fighterA: string;
  fighterB: string;
  isCurrent: boolean;
  busy: boolean;
  onOpen: () => void;
  onLock: () => void;
  onSaveDeduction: (a: number, b: number, note: string) => void;
  submissions: Submission[];
}) {
  const [a, setA] = useState(round.fighter_a_deduction);
  const [b, setB] = useState(round.fighter_b_deduction);
  const [note, setNote] = useState(round.deduction_note ?? '');
  const dedDirty =
    a !== round.fighter_a_deduction || b !== round.fighter_b_deduction || (note ?? '') !== (round.deduction_note ?? '');

  const badge =
    round.state === 'live'
      ? 'bg-emerald-500/15 text-emerald-300'
      : round.state === 'locked'
      ? 'bg-slate-700 text-slate-300'
      : 'bg-slate-800 text-slate-400';

  return (
    <div className={`rounded-2xl bg-slate-900 p-4 ${isCurrent ? 'ring-2 ring-emerald-500/60' : ''}`}>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-lg font-black">Round {round.round_number}</span>
        <span className={`rounded-full px-3 py-1 text-xs font-bold uppercase ${badge}`}>{round.state}</span>
      </div>

      {/* ---- Judge submissions: chip per judge, hover for score + note ---- */}
      <div className="mb-3 rounded-xl bg-slate-950/60 p-3">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">
          Judge cards ({fighterA.split(' ')[0]} — {fighterB.split(' ')[0]})
        </p>
        {submissions.length === 0 && <p className="text-xs text-slate-500">No judges assigned.</p>}
        <div className="flex flex-wrap gap-2">
          {submissions.map((sub) => (
            <div key={sub.label} className="group relative">
              <div
                className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm ${
                  sub.score ? 'bg-slate-800 text-slate-100' : 'bg-slate-800/50 text-slate-500'
                }`}
              >
                <span className="text-xs font-black text-slate-400">{sub.label}</span>
                <span className="font-bold tabular-nums">
                  {sub.score ? `${sub.score.fighter_a_score}-${sub.score.fighter_b_score}` : '—'}
                </span>
                {sub.score?.margin_tag && (
                  <span className="text-[9px] font-bold uppercase text-amber-300">
                    {sub.score.margin_tag[0]}
                  </span>
                )}
                {sub.score?.note && <span className="text-[10px] text-slate-500">✎</span>}
              </div>

              {/* hover detail */}
              <div className="pointer-events-none absolute bottom-full left-0 z-10 mb-1 hidden w-52 rounded-lg bg-slate-800 p-2 text-xs shadow-lg ring-1 ring-slate-700 group-hover:block">
                <p className="font-bold text-slate-100">
                  {sub.label} · {sub.short}
                </p>
                {sub.score ? (
                  <>
                    <p className="mt-0.5 text-slate-300">
                      {fighterA.split(' ')[0]} {sub.score.fighter_a_score} — {sub.score.fighter_b_score}{' '}
                      {fighterB.split(' ')[0]}
                      {sub.score.margin_tag ? ` (${sub.score.margin_tag})` : ''}
                    </p>
                    {sub.score.note && (
                      <p className="mt-1 italic text-slate-400">“{sub.score.note}”</p>
                    )}
                  </>
                ) : (
                  <p className="mt-0.5 text-slate-400">Not scored yet</p>
                )}
              </div>
            </div>
          ))}
        </div>
        {(round.fighter_a_deduction > 0 || round.fighter_b_deduction > 0) && (
          <p className="pt-2 text-[11px] font-semibold text-red-300">
            Deductions: {fighterA.split(' ')[0]} -{round.fighter_a_deduction}, {fighterB.split(' ')[0]}{' '}
            -{round.fighter_b_deduction}
            {round.deduction_note ? ` (${round.deduction_note})` : ''}
          </p>
        )}
      </div>

      <div className="mb-3 flex gap-2">
        <button
          onClick={onOpen}
          disabled={busy || round.state === 'live'}
          className="h-11 flex-1 rounded-xl bg-emerald-500 text-sm font-bold text-white disabled:opacity-40"
        >
          Open (live)
        </button>
        <button
          onClick={onLock}
          disabled={busy || round.state === 'locked'}
          className="h-11 flex-1 rounded-xl bg-slate-700 text-sm font-bold text-slate-100 disabled:opacity-40"
        >
          Lock
        </button>
      </div>

      <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">
        Point deductions
      </p>
      <div className="flex gap-2">
        <Stepper label={fighterA} value={a} onChange={setA} />
        <Stepper label={fighterB} value={b} onChange={setB} />
      </div>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Reason (e.g. low blow)"
        className="mt-2 h-10 w-full rounded-lg bg-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-600"
      />
      <button
        onClick={() => onSaveDeduction(a, b, note)}
        disabled={!dedDirty || busy}
        className="mt-2 h-10 w-full rounded-lg bg-slate-50 text-sm font-bold text-slate-950 disabled:opacity-40"
      >
        Save deductions
      </button>
    </div>
  );
}

function Stepper({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex-1 rounded-xl bg-slate-800 p-2 text-center">
      <p className="mb-1 truncate text-[11px] font-semibold text-slate-300">{label}</p>
      <div className="flex items-center justify-between">
        <button
          onClick={() => onChange(Math.max(0, value - 1))}
          className="h-9 w-9 rounded-lg bg-slate-700 text-lg font-black text-slate-100"
        >
          −
        </button>
        <span className="text-xl font-black tabular-nums">-{value}</span>
        <button
          onClick={() => onChange(Math.min(3, value + 1))}
          className="h-9 w-9 rounded-lg bg-slate-700 text-lg font-black text-slate-100"
        >
          +
        </button>
      </div>
    </div>
  );
}
