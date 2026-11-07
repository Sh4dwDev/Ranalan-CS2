import * as store from './db.js';

const toInt = (value) => Number(value) || 0;
const winnerOf = (winner) => (winner?.team === 'team1' || winner?.team === 'team2' ? winner.team : null);

// Bots report ids like BOT-3. They only count in test matches, which real stats leave out.
const isHuman = (steamId) => /^\d{17}$/.test(String(steamId));

function saveRoundEnd(match, event) {
  const mapNumber = toInt(event.map_number);
  store.saveMapScore(match.id, mapNumber, toInt(event.team1?.score), toInt(event.team2?.score), null);

  // Each round_end holds running totals for the map, so a newer one replaces the older.
  for (const [team, data] of [[1, event.team1], [2, event.team2]]) {
    for (const player of data?.players || []) {
      if (!isHuman(player.steamid) && !match.is_test) continue;
      const stats = player.stats || {};
      store.savePlayerStats(match.id, mapNumber, team, {
        steamId: String(player.steamid),
        name: String(player.name || 'Ukjent'),
        kills: toInt(stats.kills),
        deaths: toInt(stats.deaths),
        assists: toInt(stats.assists),
        headshotKills: toInt(stats.headshot_kills),
        damage: toInt(stats.damage),
        roundsPlayed: toInt(stats.rounds_played),
        mvp: toInt(stats.mvp),
      });
    }
  }
}

// Takes one event from MatchZy. Returns false if it isn't for a match on this site.
export function handleEvent(event) {
  const match = store.findMatchByMatchzyId(Number(event?.matchid));
  if (!match) return false;

  if (event.event === 'round_end') {
    saveRoundEnd(match, event);
  } else if (event.event === 'map_result') {
    store.saveMapScore(
      match.id,
      toInt(event.map_number),
      toInt(event.team1?.score),
      toInt(event.team2?.score),
      winnerOf(event.winner),
    );
  } else if (event.event === 'series_end') {
    store.finishSeries(
      match.id,
      toInt(event.team1_series_score),
      toInt(event.team2_series_score),
      winnerOf(event.winner),
    );
  }
  return true;
}
