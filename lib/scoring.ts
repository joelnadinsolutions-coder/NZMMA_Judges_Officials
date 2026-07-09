/** Optional judge annotation of how the round was won. */
export type MarginTag = 'close' | 'decisive';

export interface ScorePayload {
  fight_id: string;
  round_number: number;
  judge_id: string;
  fighter_a_score: number;
  fighter_b_score: number;
  note?: string | null;
  margin_tag?: MarginTag | null;
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
 * Single source of truth for the scoring card.
 *
 * The card renders one column per fighter. Everything about a column (the
 * fighter's name, corner colour, the winner buttons, and the saved payload)
 * must derive from the SAME fighter key ('a' | 'b') plus the fight record, so
 * a red-corner win can never be recorded against the blue fighter. Nothing is
 * mapped by array position.
 */
export type Corner = 'red' | 'blue';

/** The winning options for a fighter (that fighter scores the 10). */
export function winnerOptions(fighter: 'a' | 'b'): ScoreOption[] {
  return fighter === 'a' ? A_WINS : B_WINS;
}

/** Which fighter ('a' | 'b') is in the given corner, per the fight record. */
export function fighterInCorner(
  fight: { fighter_a_corner: string; fighter_b_corner: string },
  corner: Corner,
): 'a' | 'b' | null {
  if (fight.fighter_a_corner === corner) return 'a';
  if (fight.fighter_b_corner === corner) return 'b';
  return null;
}

/**
 * The immutable a/b payload scores for a winner and the loser's points: the
 * winner always takes 10, the loser takes their margin. This is the one place
 * the winner-to-column mapping lives.
 */
export function payloadForWinner(
  winner: 'a' | 'b',
  loserPoints: number,
): { fighter_a_score: number; fighter_b_score: number } {
  return winner === 'a'
    ? { fighter_a_score: 10, fighter_b_score: loserPoints }
    : { fighter_a_score: loserPoints, fighter_b_score: 10 };
}
