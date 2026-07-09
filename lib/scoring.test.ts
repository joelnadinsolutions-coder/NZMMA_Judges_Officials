import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  A_WINS,
  B_WINS,
  fighterInCorner,
  payloadForWinner,
  winnerOptions,
} from './scoring.ts';

// Default bout: fighter A is the red corner, fighter B is the blue corner.
const fight = { fighter_a_corner: 'red', fighter_b_corner: 'blue' };

test('red winner with loser 9 records red=10, blue=9', () => {
  const winner = fighterInCorner(fight, 'red'); // 'a'
  assert.equal(winner, 'a');
  // Red is fighter A, so fighter_a_score must be the 10.
  assert.deepEqual(payloadForWinner(winner!, 9), { fighter_a_score: 10, fighter_b_score: 9 });
});

test('blue winner with loser 9 records blue=10, red=9', () => {
  const winner = fighterInCorner(fight, 'blue'); // 'b'
  assert.equal(winner, 'b');
  // Blue is fighter B, so fighter_b_score must be the 10.
  assert.deepEqual(payloadForWinner(winner!, 9), { fighter_a_score: 9, fighter_b_score: 10 });
});

test('corner mapping follows the fight record when corners are swapped', () => {
  // If the red fighter was entered as fighter B, red must still take the 10 in
  // fighter_b_score, proving scoring tracks the corner, not the column order.
  const swapped = { fighter_a_corner: 'blue', fighter_b_corner: 'red' };
  const redWinner = fighterInCorner(swapped, 'red'); // 'b'
  assert.equal(redWinner, 'b');
  assert.deepEqual(payloadForWinner(redWinner!, 8), { fighter_a_score: 8, fighter_b_score: 10 });
});

test('winnerOptions gives each fighter the winning 10', () => {
  assert.equal(winnerOptions('a'), A_WINS);
  assert.equal(winnerOptions('b'), B_WINS);
  // Fighter A winning 10-9 stores a=10, b=9.
  assert.deepEqual({ a: A_WINS[0].a, b: A_WINS[0].b }, { a: 10, b: 9 });
  // Fighter B winning 10-9 stores a=9, b=10.
  assert.deepEqual({ a: B_WINS[0].a, b: B_WINS[0].b }, { a: 9, b: 10 });
});
