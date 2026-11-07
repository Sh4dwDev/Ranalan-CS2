import { handleEvent } from './events.js';
import { finalMaps } from './veto.js';

const randomInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

function playerResult(member, rounds) {
  const kills = randomInt(Math.floor(rounds * 0.3), Math.ceil(rounds * 1.2));
  return {
    steamid: member.steam_id,
    name: member.name,
    stats: {
      kills,
      deaths: randomInt(Math.floor(rounds * 0.3), Math.ceil(rounds * 1.1)),
      assists: randomInt(0, Math.ceil(rounds * 0.4)),
      headshot_kills: randomInt(0, kills),
      damage: rounds * randomInt(40, 120),
      rounds_played: rounds,
      mvp: randomInt(0, Math.ceil(rounds * 0.2)),
    },
  };
}

// Plays out a finished vote with random results, sending the same events MatchZy would.
export function simulateMatch({ match, state, members1, members2, winsNeeded = 9 }) {
  const matchid = Math.floor(match.created_at / 1000);
  const mapsToWin = Math.floor(finalMaps(state).length / 2) + 1;
  let wins1 = 0;
  let wins2 = 0;

  for (const [mapNumber] of finalMaps(state).entries()) {
    if (wins1 === mapsToWin || wins2 === mapsToWin) break;

    const team1Won = Math.random() < 0.5;
    const loserScore = randomInt(1, winsNeeded - 1);
    const score1 = team1Won ? winsNeeded : loserScore;
    const score2 = team1Won ? loserScore : winsNeeded;
    const rounds = score1 + score2;
    const winner = { side: '3', team: team1Won ? 'team1' : 'team2' };
    if (team1Won) wins1 += 1;
    else wins2 += 1;

    const team = (score, members) => ({ score, players: members.map((m) => playerResult(m, rounds)) });
    handleEvent({
      event: 'round_end',
      matchid,
      map_number: mapNumber,
      team1: team(score1, members1),
      team2: team(score2, members2),
    });
    handleEvent({
      event: 'map_result',
      matchid,
      map_number: mapNumber,
      winner,
      team1: { score: score1, players: [] },
      team2: { score: score2, players: [] },
    });
  }

  handleEvent({
    event: 'series_end',
    matchid,
    winner: { side: '3', team: wins1 > wins2 ? 'team1' : 'team2' },
    team1_series_score: wins1,
    team2_series_score: wins2,
  });
}
