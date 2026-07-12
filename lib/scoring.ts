/** Legacy 2-way margin tag. Kept for back-compat only; no longer written. */
export type MarginTag = 'close' | 'decisive';

/** Optional 3-way annotation of how the round was won. */
export type RoundNote = 'decisive' | 'moderate' | 'close';

export interface ScorePayload {
  fight_id: string;
  round_number: number;
  judge_id: string;
  fighter_a_score: number;
  fighter_b_score: number;
  note?: string | null;
  round_note?: RoundNote | null;
  // Kept optional so any score already sitting in the offline queue still
  // upserts cleanly; the app no longer sets it.
  margin_tag?: MarginTag | null;
}

/** A red or blue corner. The app maps it to fighter A/B per the fight. */
export type Corner = 'red' | 'blue';

/** Lifecycle of a point deduction. */
export type DeductionStatus = 'pending' | 'confirmed' | 'voided';

/** A central point-deduction record (public.deductions). */
export interface Deduction {
  id: string;
  fight_id: string;
  round_number: number;
  corner: Corner;
  points: number;
  reason: string | null;
  entered_by: string;
  status: DeductionStatus;
  confirmed_by: string | null;
  confirmed_at: string | null;
  created_at: string;
}

/** The minimum a fight tells us about which fighter is in which corner. */
export interface CornerConfig {
  fighter_a_corner: string;
  fighter_b_corner: string;
}

/**
 * Map a red/blue corner to fighter A or B for a given fight. Returns null if
 * neither corner matches (a misconfigured bout), so the caller can skip it
 * rather than silently dock the wrong fighter.
 */
export function cornerToSide(fight: CornerConfig, corner: Corner): 'a' | 'b' | null {
  if (fight.fighter_a_corner === corner) return 'a';
  if (fight.fighter_b_corner === corner) return 'b';
  return null;
}

/**
 * Sum non-voided deduction points for one round, split by fighter side.
 * Voided deductions are excluded; pending and confirmed both count (totals
 * drop the moment a deduction is entered, regardless of status).
 */
export function roundDeductionTotals(
  deductions: Deduction[],
  roundNumber: number,
  fight: CornerConfig,
): { a: number; b: number } {
  let a = 0;
  let b = 0;
  for (const d of deductions) {
    if (d.round_number !== roundNumber || d.status === 'voided') continue;
    const side = cornerToSide(fight, d.corner);
    if (side === 'a') a += d.points;
    else if (side === 'b') b += d.points;
  }
  return { a, b };
}

/** The winner side of a round in the 10-point-must system. */
export type Winner = 'a' | 'b' | 'even';

export interface ScoreOption {
  label: string;          // shown on the tap target, e.g. "10-9"
  a: number;              // fighter A points
  b: number;              // fighter B points
  winner: Winner;
  emphasis?: 'normal' | 'strong'; // 10-8 / 10-7 get visual weight
}

/**
 * Canonical MMA scoring options (unified rules).
 * Judges pick a winner column, then a margin. Even (10-10) is rare but legal.
 */
export const A_WINS: ScoreOption[] = [
  { label: '10-9', a: 10, b: 9, winner: 'a', emphasis: 'normal' },
  { label: '10-8', a: 10, b: 8, winner: 'a', emphasis: 'strong' },
  { label: '10-7', a: 10, b: 7, winner: 'a', emphasis: 'strong' },
];

// Winner-first labels: Fighter B's buttons read 10-9 / 10-8 / 10-7 (B is the
// winner who scores the 10). The stored values still record each fighter's own
// score, so B winning 10-9 is a=9, b=10.
export const B_WINS: ScoreOption[] = [
  { label: '10-9', a: 9, b: 10, winner: 'b', emphasis: 'normal' },
  { label: '10-8', a: 8, b: 10, winner: 'b', emphasis: 'strong' },
  { label: '10-7', a: 7, b: 10, winner: 'b', emphasis: 'strong' },
];

export const EVEN: ScoreOption = { label: '10-10', a: 10, b: 10, winner: 'even' };

/**
 * The two-step picker's output as an immutable a/b payload.
 *
 * Given which corner takes the 10, the loser corner's points, and which
 * fighter is the red corner (`redIsA`), return each fighter's own score. This
 * is the single source of truth for the corner-to-fighter mapping when
 * scoring, so a red-corner win can never be recorded against the blue fighter.
 * The scoring card calls this directly; the unit tests lock its behaviour.
 */
export function scoreFromCornerPick(
  tenSide: Corner,
  otherPoints: number,
  redIsA: boolean,
): { fighter_a_score: number; fighter_b_score: number } {
  const red = tenSide === 'red' ? 10 : otherPoints;
  const blue = tenSide === 'blue' ? 10 : otherPoints;
  return redIsA
    ? { fighter_a_score: red, fighter_b_score: blue }
    : { fighter_a_score: blue, fighter_b_score: red };
}
