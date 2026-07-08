'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { getSupabase } from '@/lib/supabase/client';
import { enqueueScore, pendingCount, registerAutoFlush } from '@/lib/offlineQueue';
import {
  A_WINS,
  B_WINS,
  EVEN,
  cornerToSide,
  roundDeductionTotals,
  type Corner,
  type Deduction,
  type RoundNote,
  type ScoreOption,
} from '@/lib/scoring';

interface Fight {
  id: string;
  fighter_a_name: string;
  fighter_b_name: string;
  fighter_a_corner: string;
  fighter_b_corner: string;
  scheduled_rounds: number;
  current_round: number;
  round_minutes?: number;
  is_championship?: boolean;
  state?: 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
}

type SubmitState = 'idle' | 'submitting' | 'saved' | 'pending' | 'error';
type RoundState = 'pending' | 'live' | 'locked';
type SavedScore = { a: number; b: number; note: string | null; roundNote: RoundNote | null };
type FinishMethod = 'ko' | 'tko' | 'submission' | 'dq' | 'other';
type FinishFlag = { round_number: number; method: FinishMethod; note: string | null };

const FINISH_LABEL: Record<FinishMethod, string> = {
  ko: 'KO',
  tko: 'TKO',
  submission: 'Submission',
  dq: 'DQ',
  other: 'Other',
};

const ROUND_NOTES: RoundNote[] = ['decisive', 'moderate', 'close'];
const UNDO_WINDOW_MS = 60_000;

// Every option references a stable module constant, so we can identify the
// current pick by reference (labels now collide across columns: A and B both
// show 10-9 / 10-8 / 10-7).
const ALL_OPTIONS = [...A_WINS, ...B_WINS, EVEN];
function optionFor(a: number, b: number): ScoreOption | null {
  return ALL_OPTIONS.find((o) => o.a === a && o.b === b) ?? null;
}

// Break a stored score back into "which corner got the 10" + "the other
// corner's score", to drive the two-step picker. Even (10-10) is shown as
// the red button active with the other side on 10.
function tenFromOption(
  sel: ScoreOption | null,
  redIsA: boolean,
): { side: 'red' | 'blue' | null; other: number | null } {
  if (!sel) return { side: null, other: null };
  const red = redIsA ? sel.a : sel.b;
  const blue = redIsA ? sel.b : sel.a;
  if (sel.winner === 'even') return { side: 'red', other: 10 };
  if (red === 10 && blue < 10) return { side: 'red', other: blue };
  return { side: 'blue', other: red };
}

export default function ScoringCard({ fight }: { fight: Fight }) {
  const supabase = getSupabase();
  const redIsA = fight.fighter_a_corner === 'red';
  const redName = redIsA ? fight.fighter_a_name : fight.fighter_b_name;
  const blueName = redIsA ? fight.fighter_b_name : fight.fighter_a_name;
  const [judgeId, setJudgeId] = useState<string | null>(null);
  const [round, setRound] = useState(fight.current_round);
  const [selected, setSelected] = useState<ScoreOption | null>(null);
  const [tenSide, setTenSide] = useState<'red' | 'blue' | null>(null);
  const [confirmingEven, setConfirmingEven] = useState(false);
  const [note, setNote] = useState('');
  const [roundNote, setRoundNote] = useState<RoundNote | null>(null);
  const [submit, setSubmit] = useState<SubmitState>('idle');
  const [queued, setQueued] = useState(0);
  const [online, setOnline] = useState(true);
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [roundStates, setRoundStates] = useState<Record<number, RoundState>>({});
  const [deductions, setDeductions] = useState<Deduction[]>([]);
  const [savedScores, setSavedScores] = useState<Record<number, SavedScore>>({});
  const [sheetRound, setSheetRound] = useState<number | null>(null);
  const [finishFlag, setFinishFlag] = useState<FinishFlag | null>(null);
  const [flagging, setFlagging] = useState(false);
  const [flagMethod, setFlagMethod] = useState<FinishMethod>('tko');
  const [flagNote, setFlagNote] = useState('');
  const [flagBusy, setFlagBusy] = useState(false);

  // Ref mirror of savedScores so round switches read the latest map without
  // re-subscribing effects.
  const savedRef = useRef<Record<number, SavedScore>>({});

  // Reflect a round's saved score (or a blank card) when you land on it.
  const applyRound = useCallback(
    (r: number) => {
      const s = savedRef.current[r];
      setConfirmingEven(false);
      if (s) {
        const opt = optionFor(s.a, s.b);
        setSelected(opt);
        setTenSide(tenFromOption(opt, redIsA).side);
        setNote(s.note ?? '');
        setRoundNote(s.roundNote);
        setSubmit('saved');
      } else {
        setSelected(null);
        setTenSide(null);
        setNote('');
        setRoundNote(null);
        setSubmit('idle');
      }
    },
    [redIsA],
  );

  const loadDeductions = useCallback(async () => {
    const { data } = await supabase.from('deductions').select('*').eq('fight_id', fight.id);
    setDeductions((data ?? []) as Deduction[]);
  }, [supabase, fight.id]);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setJudgeId(data.user?.id ?? null));
    registerAutoFlush();
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    setOnline(navigator.onLine);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    const t = setInterval(async () => {
      setNowTs(Date.now());
      setQueued(await pendingCount());
    }, 1000);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      clearInterval(t);
    };
  }, [supabase]);

  // Load this judge's existing scores, each round's state, and the fight's
  // deductions, then follow changes live (the official opening/locking rounds,
  // and anyone entering, confirming or voiding a deduction).
  useEffect(() => {
    if (!judgeId) return;
    let active = true;

    async function load() {
      const [{ data: scoreRows }, { data: roundRows }, { data: dedRows }, { data: flagRows }] =
        await Promise.all([
          supabase
            .from('scores')
            .select('round_number, fighter_a_score, fighter_b_score, note, round_note')
            .eq('fight_id', fight.id)
            .eq('judge_id', judgeId),
          supabase.from('rounds').select('round_number, state').eq('fight_id', fight.id),
          supabase.from('deductions').select('*').eq('fight_id', fight.id),
          supabase
            .from('judge_finish_flags')
            .select('round_number, method, note')
            .eq('fight_id', fight.id)
            .eq('judge_id', judgeId),
        ]);
      if (!active) return;

      setFinishFlag((flagRows?.[0] as FinishFlag | undefined) ?? null);

      const scores: Record<number, SavedScore> = {};
      scoreRows?.forEach((r) => {
        scores[r.round_number] = {
          a: r.fighter_a_score,
          b: r.fighter_b_score,
          note: r.note,
          roundNote: (r.round_note as RoundNote | null) ?? null,
        };
      });
      savedRef.current = scores;
      setSavedScores(scores);

      const states: Record<number, RoundState> = {};
      roundRows?.forEach((r) => {
        states[r.round_number] = r.state as RoundState;
      });
      setRoundStates(states);
      setDeductions((dedRows ?? []) as Deduction[]);

      applyRound(round);
    }
    load();

    const channel = supabase
      .channel(`judge-${fight.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rounds', filter: `fight_id=eq.${fight.id}` },
        (payload) => {
          const row = payload.new as { round_number: number; state: RoundState };
          if (row?.round_number) {
            setRoundStates((prev) => ({ ...prev, [row.round_number]: row.state }));
          }
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'deductions', filter: `fight_id=eq.${fight.id}` },
        () => loadDeductions(),
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
    // applyRound/round intentionally excluded: this effect owns loading + the
    // subscription; round changes are handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, judgeId, fight.id, loadDeductions]);

  // Show the saved score (or blank) whenever you switch rounds.
  useEffect(() => {
    applyRound(round);
  }, [round, applyRound]);

  // A round switch (official advancing, or the judge tapping a tab) does not
  // silently discard a picked-but-unconfirmed score: the card holds with a
  // prompt, advances once the score is confirmed, or leaves on a second tap.
  const [blockedTarget, setBlockedTarget] = useState<number | null>(null);

  const hasUnconfirmedPick = useCallback(() => {
    return (
      roundStates[round] === 'live' &&
      !!selected &&
      submit !== 'saved' &&
      submit !== 'pending' &&
      submit !== 'submitting'
    );
  }, [roundStates, round, selected, submit]);

  const requestRound = useCallback(
    (target: number) => {
      if (target === round) return;
      if (hasUnconfirmedPick() && blockedTarget !== target) {
        setBlockedTarget(target);
        return;
      }
      setBlockedTarget(null);
      setRound(target);
    },
    [round, hasUnconfirmedPick, blockedTarget],
  );

  // Follow the official when they advance the live round.
  useEffect(() => {
    if (fight.current_round === round) return;
    if (hasUnconfirmedPick()) {
      setBlockedTarget(fight.current_round);
      return;
    }
    setBlockedTarget(null);
    setRound(fight.current_round);
    // Only the official's advance should trigger this follow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fight.current_round]);

  // Release a held switch as soon as it is no longer blocked: the score got
  // confirmed, or the round locked out from under the judge (which makes the
  // pick unsubmittable anyway). Without this the amber "submit first" banner
  // could point at a disabled CONFIRM button, a dead end.
  useEffect(() => {
    if (blockedTarget !== null && !hasUnconfirmedPick()) {
      setRound(blockedTarget);
      setBlockedTarget(null);
    }
  }, [blockedTarget, hasUnconfirmedPick]);

  const roundState: RoundState = roundStates[round] ?? 'pending';
  const roundLive = roundState === 'live';
  const roundLocked = roundState === 'locked';
  const boutOver = fight.state === 'completed' || fight.state === 'cancelled';

  // Rounds must be scored in order: block this round if an earlier open round
  // has not been scored yet, so a judge cannot skip ahead by mistake.
  let firstUnscoredEarlier: number | null = null;
  for (let r = 1; r < round; r++) {
    if ((roundStates[r] ?? 'pending') === 'live' && !savedScores[r]) {
      firstUnscoredEarlier = r;
      break;
    }
  }
  const outOfOrder = firstUnscoredEarlier !== null;

  // Can only pick/edit a score on a live round that has not been submitted
  // yet, not out of order, and not after this judge has marked the fight
  // finished.
  const pickDisabled =
    !roundLive || outOfOrder || submit === 'submitting' || submit === 'saved' || !!finishFlag;
  const confirmDisabled = pickDisabled || !selected || !judgeId;

  // Current picker state, derived from the stored option.
  const otherScoreSel = selected ? tenFromOption(selected, redIsA).other : confirmingEven ? 10 : null;

  // Step 1: choose which corner gets the 10.
  const selectTen = useCallback(
    (side: 'red' | 'blue') => {
      if (pickDisabled) return;
      setConfirmingEven(false);
      setTenSide(side);
      setSelected(null);
    },
    [pickDisabled],
  );

  // Step 2: choose the other corner's score (10 = even, needs confirming).
  const selectOther = useCallback(
    (v: number) => {
      if (pickDisabled || !tenSide) return;
      if (v === 10) {
        setSelected(null);
        setConfirmingEven(true);
        return;
      }
      setConfirmingEven(false);
      const red = tenSide === 'red' ? 10 : v;
      const blue = tenSide === 'blue' ? 10 : v;
      const a = redIsA ? red : blue;
      const b = redIsA ? blue : red;
      setSelected(optionFor(a, b));
    },
    [pickDisabled, tenSide, redIsA],
  );

  const confirmEven = useCallback(() => {
    setSelected(EVEN);
    setConfirmingEven(false);
  }, []);

  const voidDeduction = useCallback(
    async (id: string) => {
      const { error } = await supabase.rpc('set_deduction_status', {
        d_id: id,
        new_status: 'voided',
      });
      if (!error) await loadDeductions();
    },
    [supabase, loadDeductions],
  );

  // The judge's own finish observation. Closes THEIR card only: the official
  // still closes the bout, and the official's result always overrules this.
  async function saveFinishFlag() {
    if (!judgeId || flagBusy) return;
    setFlagBusy(true);
    // Record the live round the official is on, not whichever tab the judge is
    // viewing, so a finish flagged while reviewing an earlier round is not
    // misattributed.
    const finishRound = fight.current_round;
    const { error } = await supabase.from('judge_finish_flags').upsert(
      {
        fight_id: fight.id,
        judge_id: judgeId,
        round_number: finishRound,
        method: flagMethod,
        note: flagNote.trim() || null,
      },
      { onConflict: 'fight_id,judge_id' },
    );
    if (!error) {
      setFinishFlag({ round_number: finishRound, method: flagMethod, note: flagNote.trim() || null });
      setFlagging(false);
    }
    setFlagBusy(false);
  }

  async function undoFinishFlag() {
    if (!judgeId || flagBusy) return;
    setFlagBusy(true);
    const { error } = await supabase
      .from('judge_finish_flags')
      .delete()
      .eq('fight_id', fight.id)
      .eq('judge_id', judgeId);
    if (!error) setFinishFlag(null);
    setFlagBusy(false);
  }

  const handleConfirm = useCallback(async () => {
    // ---- STATE LOCK: block re-entry so a double-tap can't double-submit ----
    if (confirmDisabled) return;
    if (!selected || !judgeId) return;
    setSubmit('submitting');

    const trimmed = note.trim();
    try {
      const reachedServer = await enqueueScore({
        fight_id: fight.id,
        round_number: round,
        judge_id: judgeId,
        fighter_a_score: selected.a,
        fighter_b_score: selected.b,
        note: trimmed || null,
        round_note: roundNote,
      });
      // Remember locally so revisiting this round shows the score.
      savedRef.current = {
        ...savedRef.current,
        [round]: { a: selected.a, b: selected.b, note: trimmed || null, roundNote },
      };
      setSavedScores(savedRef.current);
      setSubmit(reachedServer ? 'saved' : 'pending');
      setQueued(await pendingCount());
      // Whole-bout-live flow: once saved, hop to the next open, unscored round
      // so the judge can score straight through without waiting on the official.
      const next = round + 1;
      if (
        next <= fight.scheduled_rounds &&
        (roundStates[next] ?? 'pending') === 'live' &&
        !savedRef.current[next]
      ) {
        setRound(next);
      }
      // A held round switch is released by the blockedTarget effect once submit
      // flips away from an unconfirmed pick.
    } catch {
      setSubmit('error');
    }
  }, [
    confirmDisabled,
    selected,
    judgeId,
    fight.id,
    fight.scheduled_rounds,
    round,
    roundStates,
    note,
    roundNote,
  ]);

  const roundOptions = useMemo(
    () => Array.from({ length: fight.scheduled_rounds }, (_, i) => i + 1),
    [fight.scheduled_rounds],
  );

  const sortedDeductions = useMemo(
    () =>
      deductions
        .slice()
        .sort(
          (x, y) =>
            x.round_number - y.round_number || x.created_at.localeCompare(y.created_at),
        ),
    [deductions],
  );

  const formatLabel = `${fight.scheduled_rounds} rounds${
    fight.round_minutes ? ` x ${fight.round_minutes} min` : ''
  }${fight.is_championship ? ' · title' : ''}`;

  // Paper-style scorecard rows, keyed to Red / Blue corners (not fighter A/B).
  const scoreRows = roundOptions.map((r) => {
    const s = savedScores[r];
    const d = roundDeductionTotals(deductions, r, fight);
    const redScore = s ? (redIsA ? s.a : s.b) : null;
    const blueScore = s ? (redIsA ? s.b : s.a) : null;
    const redDed = redIsA ? d.a : d.b;
    const blueDed = redIsA ? d.b : d.a;
    return {
      r,
      redScore,
      blueScore,
      redDed,
      blueDed,
      redTotal: redScore == null ? null : redScore - redDed,
      blueTotal: blueScore == null ? null : blueScore - blueDed,
      note: s?.roundNote ?? null,
    };
  });
  const redTotal = scoreRows.reduce((n, x) => n + (x.redTotal ?? 0), 0);
  const blueTotal = scoreRows.reduce((n, x) => n + (x.blueTotal ?? 0), 0);
  const hasScores = Object.keys(savedScores).length > 0;

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col bg-slate-950 text-slate-50">
      {/* ---- Status bar ---- */}
      <header className="flex items-center justify-between px-4 pt-[max(env(safe-area-inset-top),1rem)] pb-3">
        <span className="flex items-center gap-2">
          <Link href="/login" className="text-lg leading-none text-slate-500">
            ‹
          </Link>
          <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">
            NZMMAF · Roundmaster
          </span>
        </span>
        <span
          className={`rounded-full px-3 py-1 text-xs font-bold ${
            online ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'
          }`}
        >
          {online ? 'ONLINE' : 'OFFLINE'}
          {queued > 0 && ` · ${queued} queued`}
        </span>
      </header>

      {/* ---- Round selector ---- */}
      <nav className="flex gap-2 px-4 pb-2">
        {roundOptions.map((r) => {
          const st = roundStates[r] ?? 'pending';
          const isCur = r === round;
          return (
            <button
              key={r}
              onClick={() => requestRound(r)}
              className={`relative h-12 flex-1 rounded-xl text-lg font-bold transition ${
                isCur ? 'bg-slate-50 text-slate-950' : 'bg-slate-800 text-slate-300'
              }`}
            >
              R{r}
              {st === 'live' && (
                <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-emerald-400" />
              )}
              {st === 'locked' && (
                <span className="absolute right-1 top-0.5 text-[11px] leading-none">🔒</span>
              )}
              {savedRef.current[r] && !isCur && (
                <span className="absolute bottom-1 left-0 right-0 text-[9px] font-bold uppercase tracking-wider text-emerald-400">
                  scored
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* ---- Format ---- */}
      <div className="px-4 pb-1 text-[11px]">
        <span className="font-semibold uppercase tracking-wider text-slate-500">{formatLabel}</span>
      </div>

      {/* ---- Compact scorecard (paper style, keyed to Red / Blue) ---- */}
      <div className="mx-4 mb-2 overflow-hidden rounded-xl ring-1 ring-slate-800">
        <table className="w-full text-center text-sm">
          <thead>
            <tr className="bg-slate-900 text-[10px] font-bold uppercase tracking-wider text-slate-400">
              <th className="py-1.5">Rd</th>
              <th className="py-1.5">
                <span className="text-red-400">Red</span> {redName.split(' ')[0]}
              </th>
              <th className="py-1.5">
                <span className="text-sky-400">Blue</span> {blueName.split(' ')[0]}
              </th>
              <th className="py-1.5">Note</th>
            </tr>
          </thead>
          <tbody>
            {scoreRows.map((x) => (
              <tr
                key={x.r}
                className={`border-t border-slate-800 ${x.r === round ? 'bg-slate-800/40' : ''}`}
              >
                <td className="py-1.5 font-black text-slate-400">{x.r}</td>
                <td className="py-1.5 font-bold tabular-nums text-slate-100">
                  {x.redScore == null ? (
                    <span className="text-slate-600">·</span>
                  ) : (
                    <>
                      {x.redTotal}
                      {x.redDed > 0 && (
                        <span className="text-[10px] font-normal text-red-400"> (-{x.redDed})</span>
                      )}
                    </>
                  )}
                </td>
                <td className="py-1.5 font-bold tabular-nums text-slate-100">
                  {x.blueScore == null ? (
                    <span className="text-slate-600">·</span>
                  ) : (
                    <>
                      {x.blueTotal}
                      {x.blueDed > 0 && (
                        <span className="text-[10px] font-normal text-red-400"> (-{x.blueDed})</span>
                      )}
                    </>
                  )}
                </td>
                <td className="py-1.5 text-[10px] font-bold uppercase text-amber-300">
                  {x.note ? x.note[0] : ''}
                </td>
              </tr>
            ))}
            <tr className="border-t border-slate-700 bg-slate-900 font-black">
              <td className="py-1.5 text-[10px] uppercase tracking-wider text-slate-400">Tot</td>
              <td
                className={`py-1.5 tabular-nums ${
                  hasScores && redTotal > blueTotal ? 'text-emerald-300' : 'text-slate-100'
                }`}
              >
                {redTotal}
              </td>
              <td
                className={`py-1.5 tabular-nums ${
                  hasScores && blueTotal > redTotal ? 'text-emerald-300' : 'text-slate-100'
                }`}
              >
                {blueTotal}
              </td>
              <td className="py-1.5 text-[10px] uppercase text-emerald-300">
                {!hasScores ? '' : redTotal > blueTotal ? 'Red' : blueTotal > redTotal ? 'Blue' : '='}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* ---- Deductions (shown on every judge's card) ---- */}
      {sortedDeductions.length > 0 && (
        <div className="mx-4 mb-2 space-y-1 rounded-lg bg-slate-900/70 px-3 py-2 ring-1 ring-slate-800">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Deductions</p>
          {sortedDeductions.map((d) => {
            const own = d.entered_by === judgeId;
            const remainingMs = UNDO_WINDOW_MS - (nowTs - Date.parse(d.created_at));
            const canUndo = own && d.status === 'pending' && remainingMs > 0;
            const undoExpired = own && d.status === 'pending' && remainingMs <= 0;
            return (
              <div key={d.id} className="flex items-center justify-between gap-2 text-xs">
                <span
                  className={
                    d.status === 'voided' ? 'text-slate-600 line-through' : 'font-semibold text-red-300'
                  }
                >
                  -{d.points} {d.corner.toUpperCase()}, Rd {d.round_number}
                  {d.reason ? ` (${d.reason})` : ''}{' '}
                  <span className="font-normal text-slate-500">
                    {d.status === 'pending'
                      ? '(pending confirmation)'
                      : d.status === 'confirmed'
                      ? '(confirmed)'
                      : '(voided)'}
                  </span>
                </span>
                {canUndo && (
                  <button
                    onClick={() => voidDeduction(d.id)}
                    className="shrink-0 rounded-md bg-amber-500/20 px-2 py-1 text-[11px] font-bold text-amber-200"
                  >
                    Undo {Math.ceil(remainingMs / 1000)}s
                  </button>
                )}
                {undoExpired && (
                  <span className="shrink-0 text-[10px] text-slate-500">
                    contact head official to amend
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ---- Bout-complete banner ---- */}
      {fight.state === 'completed' && (
        <div className="mx-4 mb-2 space-y-2">
          <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-center text-xs font-semibold text-emerald-300 ring-1 ring-emerald-500/30">
            Bout complete. The official has recorded the result.
          </p>
          <Link
            href="/login"
            className="block h-12 rounded-xl bg-slate-50 text-center text-sm font-bold leading-[3rem] text-slate-950"
          >
            Back to your bouts
          </Link>
        </div>
      )}
      {fight.state === 'cancelled' && (
        <div className="mx-4 mb-2 space-y-2">
          <p className="rounded-lg bg-red-500/10 px-3 py-2 text-center text-xs font-semibold text-red-300 ring-1 ring-red-500/30">
            This bout was cancelled.
          </p>
          <Link
            href="/login"
            className="block h-12 rounded-xl bg-slate-50 text-center text-sm font-bold leading-[3rem] text-slate-950"
          >
            Back to your bouts
          </Link>
        </div>
      )}

      {/* ---- Unsubmitted score hold ---- */}
      {blockedTarget !== null && (
        <p className="mx-4 mb-2 rounded-lg bg-amber-500/10 px-3 py-2 text-center text-xs font-semibold text-amber-300 ring-1 ring-amber-500/30">
          Round {blockedTarget} is waiting, but this round&apos;s score is not submitted. Tap
          CONFIRM SCORE to submit it, or tap round {blockedTarget} again to leave without
          submitting.
        </p>
      )}

      {/* ---- Round status banner ---- */}
      {!boutOver && !roundLive && !finishFlag && (
        <p className="mx-4 mb-2 rounded-lg bg-slate-800/60 px-3 py-2 text-center text-xs font-semibold text-slate-300">
          {roundLocked
            ? 'Round locked. Scores are final.'
            : 'This round is not open yet. Waiting for the official to start it.'}
        </p>
      )}

      {/* ---- Score-in-order hold ---- */}
      {!boutOver && roundLive && outOfOrder && !finishFlag && firstUnscoredEarlier !== null && (
        <div className="mx-4 mb-2 space-y-2 rounded-lg bg-amber-500/10 px-3 py-2 text-center ring-1 ring-amber-500/30">
          <p className="text-xs font-semibold text-amber-300">
            Score rounds in order. Round {firstUnscoredEarlier} is not scored yet.
          </p>
          <button
            onClick={() => requestRound(firstUnscoredEarlier as number)}
            className="mx-auto block rounded-lg bg-amber-500 px-4 py-1.5 text-xs font-bold text-slate-950"
          >
            Go to round {firstUnscoredEarlier}
          </button>
        </div>
      )}

      {/* ---- Judge finish flag: closes this judge's card only ---- */}
      {!boutOver && (
        <div className="mx-4 mb-2">
          {finishFlag ? (
            <div className="space-y-2 rounded-lg bg-amber-500/10 px-3 py-2 ring-1 ring-amber-500/30">
              <p className="text-center text-xs font-semibold text-amber-300">
                You marked this fight finished in R{finishFlag.round_number} by{' '}
                {FINISH_LABEL[finishFlag.method]}
                {finishFlag.note ? ` (${finishFlag.note})` : ''}. Your card is closed; the
                official records the result.
              </p>
              <button
                onClick={undoFinishFlag}
                disabled={flagBusy}
                className="mx-auto block text-xs font-semibold text-amber-200 underline underline-offset-2 disabled:opacity-40"
              >
                Undo
              </button>
            </div>
          ) : flagging ? (
            <div className="space-y-2 rounded-lg bg-slate-900 p-3 ring-1 ring-slate-700">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                Fight finished in round {fight.current_round}: how?
              </p>
              <div className="grid grid-cols-5 gap-1">
                {(Object.keys(FINISH_LABEL) as FinishMethod[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setFlagMethod(m)}
                    className={`h-10 rounded-lg text-[11px] font-bold uppercase transition ${
                      flagMethod === m ? 'bg-slate-50 text-slate-950' : 'bg-slate-800 text-slate-300'
                    }`}
                  >
                    {FINISH_LABEL[m]}
                  </button>
                ))}
              </div>
              <input
                value={flagNote}
                onChange={(e) => setFlagNote(e.target.value)}
                placeholder="Detail (e.g. knockout via punch)"
                className="h-10 w-full rounded-lg bg-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-600"
              />
              <div className="flex gap-2">
                <button
                  onClick={saveFinishFlag}
                  disabled={flagBusy}
                  className="h-10 flex-1 rounded-lg bg-amber-500 text-xs font-bold text-slate-950 disabled:opacity-40"
                >
                  Confirm (closes my card)
                </button>
                <button
                  onClick={() => setFlagging(false)}
                  className="h-10 rounded-lg bg-slate-800 px-4 text-xs font-bold text-slate-300"
                >
                  Back
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setFlagging(true)}
              className="mx-auto block text-xs font-semibold text-slate-400 underline decoration-dotted underline-offset-2"
            >
              Fight finished? Mark it
            </button>
          )}
        </div>
      )}

      {/* ---- Scoring: pick who gets the 10, then the other side's score ---- */}
      <main className="flex flex-1 flex-col gap-3 px-4">
        <div>
          <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">
            Winner (gets 10)
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => selectTen('red')}
              disabled={pickDisabled}
              className={`h-16 rounded-2xl text-lg font-black ring-2 transition disabled:opacity-40 ${
                tenSide === 'red'
                  ? 'bg-red-500 text-white ring-red-400'
                  : 'bg-slate-900 text-slate-100 ring-red-500/40'
              }`}
            >
              <span className="block text-[10px] font-bold uppercase tracking-widest opacity-80">
                Red · 10
              </span>
              {redName.split(' ')[0]}
            </button>
            <button
              onClick={() => selectTen('blue')}
              disabled={pickDisabled}
              className={`h-16 rounded-2xl text-lg font-black ring-2 transition disabled:opacity-40 ${
                tenSide === 'blue'
                  ? 'bg-sky-500 text-white ring-sky-400'
                  : 'bg-slate-900 text-slate-100 ring-sky-500/40'
              }`}
            >
              <span className="block text-[10px] font-bold uppercase tracking-widest opacity-80">
                Blue · 10
              </span>
              {blueName.split(' ')[0]}
            </button>
          </div>
        </div>

        {tenSide && (
          <div className="rounded-2xl bg-slate-900 p-3 ring-1 ring-slate-800">
            <p className="mb-2 text-center text-xs font-bold uppercase tracking-widest text-slate-400">
              {(tenSide === 'red' ? blueName : redName).split(' ')[0]} score
            </p>
            <div className="grid grid-cols-4 gap-2">
              {[10, 9, 8, 7].map((v) => (
                <button
                  key={v}
                  onClick={() => selectOther(v)}
                  disabled={pickDisabled}
                  className={`h-16 rounded-xl text-2xl font-black tabular-nums transition disabled:opacity-40 ${
                    otherScoreSel === v ? 'bg-slate-50 text-slate-950' : 'bg-slate-800 text-slate-100'
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
            <p className="mt-1 text-center text-[10px] text-slate-500">10 = even round (10-10)</p>
            {confirmingEven && (
              <div className="mt-2 space-y-2 rounded-xl bg-slate-950 p-3 ring-1 ring-amber-500/40">
                <p className="text-center text-xs font-semibold text-amber-300">
                  10-10 is exceptional. Confirm this is an even round?
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={confirmEven}
                    className="h-10 flex-1 rounded-lg bg-amber-500 text-xs font-bold text-slate-950"
                  >
                    Confirm 10-10
                  </button>
                  <button
                    onClick={() => setConfirmingEven(false)}
                    className="h-10 rounded-lg bg-slate-800 px-4 text-xs font-bold text-slate-300"
                  >
                    Back
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ---- Optional round note + free-text note ---- */}
        <div className="flex items-stretch gap-2">
          <div className="flex flex-col gap-2">
            {ROUND_NOTES.map((rn) => (
              <TagChip
                key={rn}
                label={rn[0].toUpperCase() + rn.slice(1)}
                active={roundNote === rn}
                disabled={pickDisabled}
                onClick={() => setRoundNote((t) => (t === rn ? null : rn))}
              />
            ))}
          </div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={pickDisabled}
            placeholder="Note (optional): foul, knockdown, etc."
            className="min-h-[4.5rem] flex-1 resize-none rounded-xl bg-slate-900 p-3 text-sm text-slate-100 ring-1 ring-slate-800 placeholder:text-slate-600 disabled:opacity-50"
          />
        </div>

        {/* ---- Point deduction (per round) ---- */}
        {!boutOver && !finishFlag && (
          <button
            onClick={() => setSheetRound(round)}
            className="h-12 rounded-xl bg-slate-900 text-sm font-bold text-red-300 ring-1 ring-red-500/30"
          >
            Point deduction (Rd {round})
          </button>
        )}
      </main>

      {/* ---- Confirm ---- */}
      <footer className="sticky bottom-0 space-y-2 bg-gradient-to-t from-slate-950 to-transparent px-4 pb-[max(env(safe-area-inset-bottom),1rem)] pt-4">
        {selected && submit !== 'saved' && (
          <p className="text-center text-2xl font-black tracking-tight">
            {fight.fighter_a_name.split(' ')[0]}{' '}
            <span className="tabular-nums">{selected.a}</span>
            <span className="text-slate-500"> — </span>
            <span className="tabular-nums">{selected.b}</span>{' '}
            {fight.fighter_b_name.split(' ')[0]}
          </p>
        )}

        <button
          onClick={handleConfirm}
          disabled={confirmDisabled}
          aria-live="polite"
          className={`h-16 w-full rounded-2xl text-xl font-black uppercase tracking-wide transition
            active:scale-[0.98] disabled:active:scale-100
            ${
              submit === 'saved'
                ? 'bg-emerald-500 text-white'
                : submit === 'pending'
                ? 'bg-amber-500 text-slate-950'
                : submit === 'error'
                ? 'bg-red-600 text-white'
                : selected && roundLive
                ? 'bg-slate-50 text-slate-950'
                : 'bg-slate-800 text-slate-500'
            }`}
        >
          {submit === 'submitting'
            ? 'SAVING…'
            : submit === 'saved'
            ? '✓ ROUND SUBMITTED'
            : submit === 'pending'
            ? 'SAVED OFFLINE — WILL SYNC'
            : submit === 'error'
            ? 'RETRY'
            : !roundLive
            ? roundLocked
              ? 'ROUND LOCKED'
              : 'ROUND NOT OPEN'
            : 'CONFIRM SCORE'}
        </button>
      </footer>

      {sheetRound !== null && judgeId && (
        <DeductionSheet
          fight={fight}
          round={sheetRound}
          judgeId={judgeId}
          deductions={deductions}
          onClose={() => setSheetRound(null)}
          onSaved={loadDeductions}
        />
      )}
    </div>
  );
}

function TagChip({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`h-10 w-24 rounded-xl text-sm font-bold transition disabled:opacity-40 ${
        active ? 'bg-slate-50 text-slate-950' : 'bg-slate-800 text-slate-300'
      }`}
    >
      {label}
    </button>
  );
}

// Judge-side deduction entry. Lists any EXISTING deductions for the bout first
// (a duplicate guard), then takes corner + points + optional reason. The insert
// goes straight to Supabase; the 60s undo lives on the card line item.
function DeductionSheet({
  fight,
  round,
  judgeId,
  deductions,
  onClose,
  onSaved,
}: {
  fight: Fight;
  round: number;
  judgeId: string;
  deductions: Deduction[];
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const supabase = getSupabase();
  const [corner, setCorner] = useState<Corner>(
    fight.fighter_a_corner === 'blue' && fight.fighter_b_corner === 'red' ? 'blue' : 'red',
  );
  const [points, setPoints] = useState(1);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existing = deductions
    .slice()
    .sort((a, b) => a.round_number - b.round_number || a.created_at.localeCompare(b.created_at));

  const nameForCorner = (c: Corner) => {
    const side = cornerToSide(fight, c);
    return side === 'a' ? fight.fighter_a_name : side === 'b' ? fight.fighter_b_name : c;
  };

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const { error: insErr } = await supabase.from('deductions').insert({
      fight_id: fight.id,
      round_number: round,
      corner,
      points,
      reason: reason.trim() || null,
      entered_by: judgeId,
    });
    if (insErr) {
      setError(insErr.message);
      setBusy(false);
      return;
    }
    await onSaved();
    setBusy(false);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-20 flex items-end bg-black/60" onClick={onClose}>
      <div
        className="max-h-[90dvh] w-full space-y-4 overflow-y-auto rounded-t-3xl bg-slate-950 p-4 pb-[max(env(safe-area-inset-bottom),1.5rem)] ring-1 ring-slate-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-black">Point deduction · Rd {round}</h2>
          <button onClick={onClose} className="text-sm font-semibold text-slate-400">
            Close
          </button>
        </div>

        {/* Existing deductions first, to prevent duplicates. */}
        <div className="space-y-1 rounded-xl bg-slate-900 p-3 ring-1 ring-slate-800">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
            Existing deductions on this bout
          </p>
          {existing.length === 0 ? (
            <p className="text-xs text-slate-500">None yet.</p>
          ) : (
            existing.map((d) => (
              <p
                key={d.id}
                className={`text-xs ${
                  d.status === 'voided' ? 'text-slate-600 line-through' : 'text-slate-300'
                }`}
              >
                -{d.points} {d.corner.toUpperCase()}, Rd {d.round_number}
                {d.reason ? ` (${d.reason})` : ''} · {d.status}
              </p>
            ))
          )}
        </div>

        <div>
          <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">Corner</p>
          <div className="flex gap-2">
            {(['red', 'blue'] as Corner[]).map((c) => (
              <button
                key={c}
                onClick={() => setCorner(c)}
                className={`h-12 flex-1 rounded-xl text-sm font-bold uppercase transition ${
                  corner === c
                    ? c === 'red'
                      ? 'bg-red-500 text-white'
                      : 'bg-sky-500 text-white'
                    : 'bg-slate-800 text-slate-300'
                }`}
              >
                {c} · {nameForCorner(c).split(' ')[0]}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">Points</p>
          <div className="flex items-center justify-between rounded-xl bg-slate-900 p-2">
            <button
              onClick={() => setPoints((p) => Math.max(1, p - 1))}
              className="h-11 w-11 rounded-lg bg-slate-700 text-xl font-black"
            >
              −
            </button>
            <span className="text-2xl font-black tabular-nums">-{points}</span>
            <button
              onClick={() => setPoints((p) => Math.min(3, p + 1))}
              className="h-11 w-11 rounded-lg bg-slate-700 text-xl font-black"
            >
              +
            </button>
          </div>
        </div>

        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (optional): low blow, holding fence, etc."
          className="h-12 w-full rounded-xl bg-slate-900 px-3 text-sm text-slate-100 ring-1 ring-slate-800 placeholder:text-slate-600"
        />

        {error && <p className="text-sm text-red-400">{error}</p>}

        <button
          onClick={submit}
          disabled={busy}
          className="h-14 w-full rounded-2xl bg-red-500 text-lg font-black text-white disabled:opacity-40"
        >
          {busy ? 'Saving…' : `Enter -${points} ${corner.toUpperCase()}`}
        </button>
        <p className="text-center text-[11px] text-slate-500">
          You can undo this within 60 seconds. After that, the head official must amend it.
        </p>
      </div>
    </div>
  );
}
