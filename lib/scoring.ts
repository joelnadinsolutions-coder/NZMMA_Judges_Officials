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
