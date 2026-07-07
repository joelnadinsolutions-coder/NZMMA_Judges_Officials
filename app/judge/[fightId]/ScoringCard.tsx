'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { getSupabase } from '@/lib/supabase/client';
import { enqueueScore, pendingCount, registerAutoFlush } from '@/lib/offlineQueue';
import { A_WINS, B_WINS, EVEN, type MarginTag, type ScoreOption } from '@/lib/scoring';

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
type SavedScore = { a: number; b: number; note: string | null; tag: MarginTag | null };
type FinishMethod = 'ko' | 'tko' | 'submission' | 'dq' | 'other';
type FinishFlag = { round_number: number; method: FinishMethod; note: string | null };

const FINISH_LABEL: Record<FinishMethod, string> = {
  ko: 'KO',
  tko: 'TKO',
  submission: 'Submission',
  dq: 'DQ',
  other: 'Other',
};

// Every option references a stable module constant, so we can identify the
// current pick by reference (labels now collide across columns: A and B both
// show 10-9 / 10-8 / 10-7).
const ALL_OPTIONS = [...A_WINS, ...B_WINS, EVEN];
function optionFor(a: number, b: number): ScoreOption | null {
  return ALL_OPTIONS.find((o) => o.a === a && o.b === b) ?? null;
}

export default function ScoringCard({ fight }: { fight: Fight }) {
  const supabase = getSupabase();
  const [judgeId, setJudgeId] = useState<string | null>(null);
  const [round, setRound] = useState(fight.current_round);
  const [selected, setSelected] = useState<ScoreOption | null>(null);
  const [note, setNote] = useState('');
  const [marginTag, setMarginTag] = useState<MarginTag | null>(null);
  const [submit, setSubmit] = useState<SubmitState>('idle');
  const [queued, setQueued] = useState(0);
  const [online, setOnline] = useState(true);
  const [roundStates, setRoundStates] = useState<Record<number, RoundState>>({});
  const [deductions, setDeductions] = useState<Record<number, { a: number; b: number }>>({});
  const [savedScores, setSavedScores] = useState<Record<number, SavedScore>>({});
  const [finishFlag, setFinishFlag] = useState<FinishFlag | null>(null);
  const [flagging, setFlagging] = useState(false);
  const [flagMethod, setFlagMethod] = useState<FinishMethod>('tko');
  const [flagNote, setFlagNote] = useState('');
  const [flagBusy, setFlagBusy] = useState(false);

  // Ref mirror of savedScores so round switches read the latest map without
  // re-subscribing effects.
  const savedRef = useRef<Record<number, SavedScore>>({});

  // Reflect a round's saved score (or a blank card) when you land on it.
  const applyRound = useCallback((r: number) => {
    const s = savedRef.current[r];
    if (s) {
      setSelected(optionFor(s.a, s.b));
      setNote(s.note ?? '');
      setMarginTag(s.tag);
      setSubmit('saved');
    } else {
      setSelected(null);
      setNote('');
      setMarginTag(null);
      setSubmit('idle');
    }
  }, []);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setJudgeId(data.user?.id ?? null));
    registerAutoFlush();
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    setOnline(navigator.onLine);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    const t = setInterval(async () => setQueued(await pendingCount()), 2000);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      clearInterval(t);
    };
  }, [supabase]);

  // Load this judge's existing scores + each round's state, and follow round
  // changes live (the official opening/locking rounds).
  useEffect(() => {
    if (!judgeId) return;
    let active = true;

    async function load() {
      const [{ data: scoreRows }, { data: roundRows }, { data: flagRows }] = await Promise.all([
        supabase
          .from('scores')
          .select('round_number, fighter_a_score, fighter_b_score, note, margin_tag')
          .eq('fight_id', fight.id)
          .eq('judge_id', judgeId),
        supabase
          .from('rounds')
          .select('round_number, state, fighter_a_deduction, fighter_b_deduction')
          .eq('fight_id', fight.id),
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
          tag: (r.margin_tag as MarginTag | null) ?? null,
        };
      });
      savedRef.current = scores;
      setSavedScores(scores);

      const states: Record<number, RoundState> = {};
      const deds: Record<number, { a: number; b: number }> = {};
      roundRows?.forEach((r) => {
        states[r.round_number] = r.state as RoundState;
        deds[r.round_number] = { a: r.fighter_a_deduction ?? 0, b: r.fighter_b_deduction ?? 0 };
      });
      setRoundStates(states);
      setDeductions(deds);

      applyRound(round);
    }
    load();

    const channel = supabase
      .channel(`rounds-${fight.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rounds', filter: `fight_id=eq.${fight.id}` },
        (payload) => {
          const row = payload.new as {
            round_number: number;
            state: RoundState;
            fighter_a_deduction?: number;
            fighter_b_deduction?: number;
          };
          if (row?.round_number) {
            setRoundStates((prev) => ({ ...prev, [row.round_number]: row.state }));
            setDeductions((prev) => ({
              ...prev,
              [row.round_number]: { a: row.fighter_a_deduction ?? 0, b: row.fighter_b_deduction ?? 0 },
            }));
          }
        },
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
    // applyRound/round intentionally excluded: this effect owns loading + the
    // subscription; round changes are handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, judgeId, fight.id]);

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

  const cornerClass = (corner: string) =>
    corner === 'red' ? 'ring-red-500/70' : corner === 'blue' ? 'ring-sky-500/70' : 'ring-slate-500/70';

  const roundState: RoundState = roundStates[round] ?? 'pending';
  const roundLive = roundState === 'live';
  const roundLocked = roundState === 'locked';

  // Can only pick/edit a score on a live round that has not been submitted
  // yet, and not after this judge has marked the fight finished.
  const pickDisabled = !roundLive || submit === 'submitting' || submit === 'saved' || !!finishFlag;
  const confirmDisabled = pickDisabled || !selected || !judgeId;

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
        margin_tag: marginTag,
      });
      // Remember locally so revisiting this round shows the score.
      savedRef.current = {
        ...savedRef.current,
        [round]: { a: selected.a, b: selected.b, note: trimmed || null, tag: marginTag },
      };
      setSavedScores(savedRef.current);
      setSubmit(reachedServer ? 'saved' : 'pending');
      setQueued(await pendingCount());
      // A held round switch is released by the blockedTarget effect once submit
      // flips away from an unconfirmed pick.
    } catch {
      setSubmit('error');
    }
  }, [confirmDisabled, selected, judgeId, fight.id, round, note, marginTag]);

  const roundOptions = useMemo(
    () => Array.from({ length: fight.scheduled_rounds }, (_, i) => i + 1),
    [fight.scheduled_rounds],
  );

  // Running scorecard: base 10-point-must scores minus referee deductions.
  const tally = useMemo(() => {
    let a = 0;
    let b = 0;
    for (const [rnum, s] of Object.entries(savedScores)) {
      const d = deductions[Number(rnum)] ?? { a: 0, b: 0 };
      a += s.a - d.a;
      b += s.b - d.b;
    }
    return { a, b };
  }, [savedScores, deductions]);

  const hasScores = Object.keys(savedScores).length > 0;
  const shortA = fight.fighter_a_name.split(' ')[0];
  const shortB = fight.fighter_b_name.split(' ')[0];
  const formatLabel = `${fight.scheduled_rounds} rounds${
    fight.round_minutes ? ` x ${fight.round_minutes} min` : ''
  }${fight.is_championship ? ' · title' : ''}`;

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

      {/* ---- Format + running card ---- */}
      <div className="flex items-center justify-between px-4 pb-2 text-xs">
        <span className="font-semibold uppercase tracking-wider text-slate-500">{formatLabel}</span>
        {hasScores && (
          <span className="font-bold text-slate-200">
            Card: {shortA} <span className="tabular-nums">{tally.a}</span>
            <span className="text-slate-500"> — </span>
            <span className="tabular-nums">{tally.b}</span> {shortB}
          </span>
        )}
      </div>

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
      {fight.state !== 'completed' && fight.state !== 'cancelled' && !roundLive && !finishFlag && (
        <p className="mx-4 mb-2 rounded-lg bg-slate-800/60 px-3 py-2 text-center text-xs font-semibold text-slate-300">
          {roundLocked
            ? 'Round locked. Scores are final.'
            : 'This round is not open yet. Waiting for the official to start it.'}
        </p>
      )}

      {/* ---- Judge finish flag: closes this judge's card only ---- */}
      {fight.state !== 'completed' && fight.state !== 'cancelled' && (
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

      {/* ---- Fighter columns ---- */}
      <main className="flex flex-1 flex-col gap-4 px-4">
        <FighterColumn
          name={fight.fighter_a_name}
          corner={fight.fighter_a_corner}
          ringClass={cornerClass(fight.fighter_a_corner)}
          options={A_WINS}
          selected={selected}
          onPick={setSelected}
          disabled={pickDisabled}
        />

        <button
          onClick={() => setSelected(EVEN)}
          disabled={pickDisabled}
          className={`h-14 rounded-xl border-2 text-lg font-bold transition disabled:opacity-40 ${
            selected?.winner === 'even'
              ? 'border-slate-50 bg-slate-50 text-slate-950'
              : 'border-slate-700 text-slate-300'
          }`}
        >
          EVEN ROUND · 10-10
        </button>

        <FighterColumn
          name={fight.fighter_b_name}
          corner={fight.fighter_b_corner}
          ringClass={cornerClass(fight.fighter_b_corner)}
          options={B_WINS}
          selected={selected}
          onPick={setSelected}
          disabled={pickDisabled}
        />

        {/* ---- Optional tags + note (beside the score) ---- */}
        <div className="flex items-stretch gap-2">
          <div className="flex flex-col gap-2">
            <TagChip
              label="Close"
              active={marginTag === 'close'}
              disabled={pickDisabled}
              onClick={() => setMarginTag((t) => (t === 'close' ? null : 'close'))}
            />
            <TagChip
              label="Decisive"
              active={marginTag === 'decisive'}
              disabled={pickDisabled}
              onClick={() => setMarginTag((t) => (t === 'decisive' ? null : 'decisive'))}
            />
          </div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={pickDisabled}
            placeholder="Note (optional): foul, knockdown, etc."
            className="min-h-[5.5rem] flex-1 resize-none rounded-xl bg-slate-900 p-3 text-sm text-slate-100 ring-1 ring-slate-800 placeholder:text-slate-600 disabled:opacity-50"
          />
        </div>
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
          className={`h-20 w-full rounded-2xl text-2xl font-black uppercase tracking-wide transition
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
    </div>
  );
}

function FighterColumn({
  name,
  corner,
  ringClass,
  options,
  selected,
  onPick,
  disabled,
}: {
  name: string;
  corner: string;
  ringClass: string;
  options: ScoreOption[];
  selected: ScoreOption | null;
  onPick: (o: ScoreOption) => void;
  disabled: boolean;
}) {
  return (
    <section className={`rounded-2xl bg-slate-900 p-3 ring-2 ${ringClass}`}>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="truncate text-xl font-extrabold">{name}</h2>
        <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
          {corner} corner
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {options.map((o) => {
          const isSel = selected === o;
          return (
            <button
              key={o.label}
              onClick={() => onPick(o)}
              disabled={disabled}
              className={`h-16 rounded-xl text-xl font-black tabular-nums transition disabled:opacity-40
                ${
                  isSel
                    ? 'bg-slate-50 text-slate-950'
                    : o.emphasis === 'strong'
                    ? 'bg-slate-800 text-amber-300'
                    : 'bg-slate-800 text-slate-100'
                }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </section>
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
