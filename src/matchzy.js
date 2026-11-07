import { finalMaps } from './veto.js';

// Builds the match config that MatchZy downloads with matchzy_loadmatch_url.
export function buildMatchConfig({ match, team1, team2, members1, members2, admins, state, server }) {
  const maps = finalMaps(state);
  const roster = (members) => Object.fromEntries(members.map((m) => [m.steam_id, m.name]));

  // MatchZy kicks anyone not listed, so admins not playing join as spectators.
  const playing = new Set([...members1, ...members2].map((m) => m.steam_id));
  const spectators = admins.filter((a) => !playing.has(a.steam_id));

  return {
    // Site ids can repeat after a match is deleted, and MatchZy keeps stats by this id.
    matchid: Math.floor(match.created_at / 1000),
    num_maps: maps.length,
    maplist: maps.map((m) => m.map),
    map_sides: maps.map((m) => m.side),
    skip_veto: true,
    clinch_series: true,
    wingman: server.mode === 'wingman',
    players_per_team: server.playersPerTeam,
    min_players_to_ready: server.playersPerTeam,
    team1: { name: team1.name, players: roster(members1) },
    team2: { name: team2.name, players: roster(members2) },
    spectators: { players: roster(spectators) },
    min_spectators_to_ready: 0,
  };
}
