import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAP_POOLS, buildSteps, computeState, finalMaps, validateAction } from '../src/veto.js';

const pool = MAP_POOLS.wingman;

function play(format, firstTeam, values) {
  return computeState({ format, firstTeam, pool, actions: values.map((value) => ({ value })) });
}

test('BO3 order: bans, picks with sides, bans, then a decider', () => {
  assert.deepEqual(buildSteps('bo3', 2, 7), [
    { team: 2, action: 'ban' },
    { team: 1, action: 'ban' },
    { team: 2, action: 'pick' },
    { team: 1, action: 'side' },
    { team: 1, action: 'pick' },
    { team: 2, action: 'side' },
    { team: 2, action: 'ban' },
    { team: 1, action: 'ban' },
  ]);
});

test('BO1 alternates bans, then the team without the last ban picks a side', () => {
  const steps = buildSteps('bo1', 1, 7);
  assert.equal(steps.length, 7);
  assert.deepEqual(steps.slice(0, 6).map((s) => s.team), [1, 2, 1, 2, 1, 2]);
  assert.deepEqual(steps.at(-1), { team: 1, action: 'side' });
});

test('a full BO3 gives three maps with a knife decider', () => {
  const state = play('bo3', 1, [
    'de_poseidon', 'de_overpass', 'de_nuke', 'ct', 'de_inferno', 't', 'de_vertigo', 'de_debris',
  ]);
  assert.equal(state.done, true);
  assert.deepEqual(finalMaps(state), [
    { map: 'de_nuke', side: 'team2_ct' },
    { map: 'de_inferno', side: 'team1_t' },
    { map: 'de_eldorado', side: 'knife' },
  ]);
});

test('a full BO1 gives the last map with the chosen side', () => {
  const state = play('bo1', 1, [
    'de_poseidon', 'de_overpass', 'de_nuke', 'de_inferno', 'de_vertigo', 'de_debris', 't',
  ]);
  assert.equal(state.done, true);
  assert.deepEqual(finalMaps(state), [{ map: 'de_eldorado', side: 'team1_t' }]);
});

test('the side step names the map it is for', () => {
  const state = play('bo3', 1, ['de_poseidon', 'de_overpass', 'de_nuke']);
  assert.deepEqual(state.current, { team: 2, action: 'side', map: 'de_nuke' });
});

test('rejects the wrong team, used maps and bad sides', () => {
  const state = play('bo3', 1, ['de_poseidon']);
  assert.ok(validateAction(state, 1, 'de_nuke'));
  assert.ok(validateAction(state, 2, 'de_poseidon'));
  assert.equal(validateAction(state, 2, 'de_nuke'), null);

  const sideState = play('bo3', 1, ['de_poseidon', 'de_overpass', 'de_nuke']);
  assert.ok(validateAction(sideState, 2, 'de_inferno'));
  assert.equal(validateAction(sideState, 2, 't'), null);
});

test('rejects actions once the vote is done', () => {
  const state = play('bo1', 1, [
    'de_poseidon', 'de_overpass', 'de_nuke', 'de_inferno', 'de_vertigo', 'de_debris', 't',
  ]);
  assert.ok(validateAction(state, 1, 'de_eldorado'));
});
