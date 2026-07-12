import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cornerToSide, scoreFromCornerPick } from './scoring.ts';

// The judge card's two-step picker: tap the winning corner, then the loser's
// score. These lock the corner-to-fighter mapping so a red win can never be
// recorded against the blue fighter.

test('red winner, loser 9, red is fighter A: red=10, blue=9', () => {
  // redIsA = true means fighter A is the red corner (the default bout).
  const p = scoreFromCornerPick('red', 9, true);
  assert.deepEqual(p, { fighter_a_score: 10, fighter_b_score: 9 });
});

test('blue winner, loser 9, red is fighter A: blue=10, red=9', () => {
  const p = scoreFromCornerPick('blue', 9, true);
  // Fighter B is the blue corner, so the 10 lands on fighter_b_score.
  assert.deepEqual(p, { fighter_a_score: 9, fighter_b_score: 10 });
});

test('red winner, loser 8, red is fighter B (corners swapped): red still gets 10', () => {
  // redIsA = false: fighter A is the blue corner, fighter B the red.
  const p = scoreFromCornerPick('red', 8, false);
  assert.deepEqual(p, { fighter_a_score: 8, fighter_b_score: 10 });
});

test('blue winner, loser 8, red is fighter B (corners swapped): blue gets 10', () => {
  const p = scoreFromCornerPick('blue', 8, false);
  assert.deepEqual(p, { fighter_a_score: 10, fighter_b_score: 8 });
});

test('the tapped corner always receives the 10, in red/blue terms', () => {
  for (const redIsA of [true, false]) {
    for (const tenSide of ['red', 'blue'] as const) {
      const p = scoreFromCornerPick(tenSide, 9, redIsA);
      const redScore = redIsA ? p.fighter_a_score : p.fighter_b_score;
      const blueScore = redIsA ? p.fighter_b_score : p.fighter_a_score;
      const gotTen = redScore === 10 ? 'red' : 'blue';
      assert.equal(gotTen, tenSide, `tap ${tenSide} with redIsA=${redIsA} must give that corner the 10`);
    }
  }
});

test('cornerToSide maps corners to fighters per the fight record', () => {
  assert.equal(cornerToSide({ fighter_a_corner: 'red', fighter_b_corner: 'blue' }, 'red'), 'a');
  assert.equal(cornerToSide({ fighter_a_corner: 'red', fighter_b_corner: 'blue' }, 'blue'), 'b');
  assert.equal(cornerToSide({ fighter_a_corner: 'blue', fighter_b_corner: 'red' }, 'red'), 'b');
});
