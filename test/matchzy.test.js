import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMatchConfig } from '../src/matchzy.js';

const state = {
  picks: [{ map: 'de_nuke', team: null, sideTeam: 1, side: 't' }],
  decider: null,
};

function build(admins) {
  return buildMatchConfig({
    match: { id: 4, created_at: 1794047343285 },
    team1: { name: 'Alfa' },
    team2: { name: 'Bravo' },
    members1: [{ steam_id: '1', name: 'A' }],
    members2: [{ steam_id: '2', name: 'B' }],
    admins,
    state,
    server: { mode: 'wingman', playersPerTeam: 2 },
  });
}

test('lists the maps, sides and rosters', () => {
  const config = build([]);
  assert.equal(config.matchid, 1794047343);
  assert.deepEqual(config.maplist, ['de_nuke']);
  assert.deepEqual(config.map_sides, ['team1_t']);
  assert.equal(config.wingman, true);
  assert.deepEqual(config.team1.players, { 1: 'A' });
  assert.deepEqual(config.team2.players, { 2: 'B' });
});

test('admins not playing join as spectators, and playing admins stay on their team', () => {
  const config = build([{ steam_id: '1', name: 'A' }, { steam_id: '9', name: 'Admin' }]);
  assert.deepEqual(config.spectators.players, { 9: 'Admin' });
  assert.deepEqual(config.team1.players, { 1: 'A' });
});
