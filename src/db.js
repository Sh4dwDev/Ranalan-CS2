import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { MAP_POOLS, computeState } from './veto.js';

export const db = new DatabaseSync(process.env.DB_FILE || join(config.dataDir, 'ranalan.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    steam_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    avatar TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    captain_id TEXT NOT NULL REFERENCES users(steam_id),
    invite_token TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS team_members (
    steam_id TEXT PRIMARY KEY REFERENCES users(steam_id),
    team_id INTEGER NOT NULL REFERENCES teams(id)
  );

  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY,
    team1_id INTEGER NOT NULL REFERENCES teams(id),
    team2_id INTEGER NOT NULL REFERENCES teams(id),
    format TEXT NOT NULL,
    server_id TEXT NOT NULL,
    pool TEXT NOT NULL,
    first_team INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'veto',
    send_error TEXT,
    config_token TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS veto_actions (
    match_id INTEGER NOT NULL REFERENCES matches(id),
    seq INTEGER NOT NULL,
    value TEXT NOT NULL,
    steam_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (match_id, seq)
  );

  CREATE TABLE IF NOT EXISTS match_maps (
    match_id INTEGER NOT NULL REFERENCES matches(id),
    map_number INTEGER NOT NULL,
    team1_score INTEGER NOT NULL DEFAULT 0,
    team2_score INTEGER NOT NULL DEFAULT 0,
    winner TEXT,
    PRIMARY KEY (match_id, map_number)
  );

  CREATE TABLE IF NOT EXISTS player_map_stats (
    match_id INTEGER NOT NULL REFERENCES matches(id),
    map_number INTEGER NOT NULL,
    steam_id TEXT NOT NULL,
    team INTEGER NOT NULL,
    name TEXT NOT NULL,
    kills INTEGER NOT NULL DEFAULT 0,
    deaths INTEGER NOT NULL DEFAULT 0,
    assists INTEGER NOT NULL DEFAULT 0,
    headshot_kills INTEGER NOT NULL DEFAULT 0,
    damage INTEGER NOT NULL DEFAULT 0,
    rounds_played INTEGER NOT NULL DEFAULT 0,
    mvp INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (match_id, map_number, steam_id)
  );
`);

// Columns added after the first release, for databases that already exist.
const matchColumns = db.prepare('PRAGMA table_info(matches)').all().map((c) => c.name);
for (const [name, type] of [
  ['team1_series', 'INTEGER'],
  ['team2_series', 'INTEGER'],
  ['winner', 'TEXT'],
  ['is_test', 'INTEGER NOT NULL DEFAULT 0'],
  ['created_by', 'TEXT'],
]) {
  if (!matchColumns.includes(name)) db.exec(`ALTER TABLE matches ADD COLUMN ${name} ${type}`);
}
if (!db.prepare('PRAGMA table_info(teams)').all().some((c) => c.name === 'is_test')) {
  db.exec('ALTER TABLE teams ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0');
}

function deleteMatchRows(whereSql, ...params) {
  for (const table of ['veto_actions', 'match_maps', 'player_map_stats']) {
    db.prepare(`DELETE FROM ${table} WHERE match_id IN (SELECT id FROM matches WHERE ${whereSql})`).run(...params);
  }
  db.prepare(`DELETE FROM matches WHERE ${whereSql}`).run(...params);
}

const token = () => randomBytes(16).toString('base64url');

// Test players get ids no real Steam account has, which keeps them apart from real users.
const TEST_ID_PREFIX = '9000000000000';

// Users

export function upsertUser(steamId, { name, avatar }, isAdmin) {
  db.prepare(`
    INSERT INTO users (steam_id, name, avatar, is_admin, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (steam_id) DO UPDATE SET
      name = COALESCE(?, name),
      avatar = COALESCE(?, avatar),
      is_admin = MAX(is_admin, excluded.is_admin)
  `).run(steamId, name || `Spiller ${steamId.slice(-4)}`, avatar, isAdmin ? 1 : 0, Date.now(), name, avatar);
}

export const getUser = (steamId) => db.prepare('SELECT * FROM users WHERE steam_id = ?').get(steamId);
export const listUsers = () => db.prepare(
  `SELECT * FROM users WHERE steam_id NOT LIKE '${TEST_ID_PREFIX}%' ORDER BY name COLLATE NOCASE`,
).all();

export function setAdmin(steamId, isAdmin) {
  db.prepare('UPDATE users SET is_admin = ? WHERE steam_id = ?').run(isAdmin ? 1 : 0, steamId);
}

// Teams

export function createTeam(name, captainId) {
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO teams (name, captain_id, invite_token, created_at) VALUES (?, ?, ?, ?)',
  ).run(name, captainId, token(), Date.now());
  const teamId = Number(lastInsertRowid);
  db.prepare('INSERT INTO team_members (steam_id, team_id) VALUES (?, ?)').run(captainId, teamId);
  return teamId;
}

export const getTeam = (id) => db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
export const getTeamByName = (name) => db.prepare('SELECT * FROM teams WHERE name = ?').get(name);
export const getTeamByInvite = (t) => db.prepare('SELECT * FROM teams WHERE invite_token = ?').get(t);
export const listTeams = () => db.prepare('SELECT * FROM teams WHERE is_test = 0 ORDER BY name COLLATE NOCASE').all();

// The two hidden teams test matches are played between, created the first time they're needed.
export function testTeams() {
  const existing = db.prepare('SELECT id FROM teams WHERE is_test = 1 ORDER BY id').all();
  if (existing.length === 2) return existing.map((t) => t.id);

  return [['TEST Alfa', 1], ['TEST Bravo', 3]].map(([name, start]) => {
    const ids = [start, start + 1].map((n) => `${TEST_ID_PREFIX}000${n}`);
    ids.forEach((id, i) => upsertUser(id, { name: `${name.split(' ')[1]} Bot ${i + 1}`, avatar: null }, false));
    const teamId = createTeam(name, ids[0]);
    db.prepare('UPDATE teams SET is_test = 1 WHERE id = ?').run(teamId);
    addMember(teamId, ids[1]);
    return teamId;
  });
}

export function getUserTeam(steamId) {
  return db.prepare(`
    SELECT t.* FROM teams t JOIN team_members m ON m.team_id = t.id WHERE m.steam_id = ?
  `).get(steamId);
}

export function teamMembers(teamId) {
  return db.prepare(`
    SELECT u.* FROM users u JOIN team_members m ON m.steam_id = u.steam_id
    WHERE m.team_id = ? ORDER BY u.name COLLATE NOCASE
  `).all(teamId);
}

export function addMember(teamId, steamId) {
  db.prepare('INSERT INTO team_members (steam_id, team_id) VALUES (?, ?)').run(steamId, teamId);
}

export function removeMember(teamId, steamId) {
  db.prepare('DELETE FROM team_members WHERE team_id = ? AND steam_id = ?').run(teamId, steamId);
}

export function setCaptain(teamId, steamId) {
  db.prepare('UPDATE teams SET captain_id = ? WHERE id = ?').run(steamId, teamId);
}

export function newInvite(teamId) {
  db.prepare('UPDATE teams SET invite_token = ? WHERE id = ?').run(token(), teamId);
}

// A team locked into a running match keeps its roster until that match is finished.
export function teamHasOpenMatch(teamId) {
  return Boolean(db.prepare(`
    SELECT 1 FROM matches WHERE (team1_id = ? OR team2_id = ?) AND status != 'finished' LIMIT 1
  `).get(teamId, teamId));
}

// Removes a team along with its members' places and its finished matches.
export function deleteTeam(teamId) {
  db.exec('BEGIN');
  try {
    deleteMatchRows('team1_id = ? OR team2_id = ?', teamId, teamId);
    db.prepare('DELETE FROM team_members WHERE team_id = ?').run(teamId);
    db.prepare('DELETE FROM teams WHERE id = ?').run(teamId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Matches

export function createMatch({ team1Id, team2Id, format, server, firstTeam, isTest = false, createdBy = null }) {
  // MatchZy's match id is the creation time in seconds, so each match needs its own second.
  let createdAt = Date.now();
  while (db.prepare('SELECT 1 FROM matches WHERE created_at / 1000 = ?').get(Math.floor(createdAt / 1000))) {
    createdAt += 1000;
  }

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO matches (team1_id, team2_id, format, server_id, pool, first_team, config_token, created_at, is_test, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    team1Id, team2Id, format, server.id, JSON.stringify(MAP_POOLS[server.mode]),
    firstTeam, token(), createdAt, isTest ? 1 : 0, createdBy,
  );
  return Number(lastInsertRowid);
}

export function deleteMatch(id) {
  db.exec('BEGIN');
  try {
    deleteMatchRows('id = ?', id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getMatch(id) {
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
  if (match) match.pool = JSON.parse(match.pool);
  return match;
}

export function listMatches({ includeTests = false } = {}) {
  return db.prepare(`
    SELECT m.id, m.format, m.status, m.created_at, m.server_id, m.is_test,
           t1.name AS team1_name, t2.name AS team2_name
    FROM matches m JOIN teams t1 ON t1.id = m.team1_id JOIN teams t2 ON t2.id = m.team2_id
    ${includeTests ? '' : 'WHERE m.is_test = 0'}
    ORDER BY m.id DESC LIMIT 30
  `).all();
}

export function vetoActions(matchId) {
  return db.prepare('SELECT seq, value, steam_id FROM veto_actions WHERE match_id = ? ORDER BY seq').all(matchId);
}

export function addVetoAction(matchId, seq, value, steamId) {
  db.prepare('INSERT INTO veto_actions (match_id, seq, value, steam_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(matchId, seq, value, steamId, Date.now());
}

export function setMatchStatus(id, status, sendError = null) {
  db.prepare('UPDATE matches SET status = ?, send_error = ? WHERE id = ?').run(status, sendError, id);
}

// A match that still needs the server, from the start of the vote to the end of the series.
export function serverHasOpenMatch(serverId) {
  return Boolean(db.prepare(
    "SELECT 1 FROM matches WHERE server_id = ? AND status IN ('veto', 'sending', 'sent') LIMIT 1",
  ).get(serverId));
}

export function matchesBeingSent() {
  return db.prepare("SELECT id FROM matches WHERE status = 'sending'").all().map((row) => getMatch(row.id));
}

export function serverBusyWith(serverId, exceptMatchId) {
  return db.prepare(`
    SELECT id FROM matches WHERE server_id = ? AND status = 'sent' AND id != ? LIMIT 1
  `).get(serverId, exceptMatchId);
}

// Admins can always join a server. Everyone else needs to be on a team in its loaded match.
export function mayJoinServer(serverId, steamId) {
  if (getUser(steamId)?.is_admin) return true;
  return Boolean(db.prepare(`
    SELECT 1 FROM matches m
    JOIN team_members tm ON tm.team_id IN (m.team1_id, m.team2_id)
    WHERE m.server_id = ? AND m.status IN ('sending', 'sent') AND tm.steam_id = ?
    LIMIT 1
  `).get(serverId, steamId));
}

export function loadedTestMatch(serverId) {
  return db.prepare(
    "SELECT * FROM matches WHERE server_id = ? AND status = 'sent' AND is_test = 1 LIMIT 1",
  ).get(serverId);
}

export function serverHasLoadedMatch(serverId) {
  return Boolean(db.prepare("SELECT 1 FROM matches WHERE server_id = ? AND status = 'sent' LIMIT 1").get(serverId));
}

// Results and stats reported by MatchZy

export function findMatchByMatchzyId(matchzyId) {
  const row = db.prepare('SELECT id FROM matches WHERE created_at / 1000 = ?').get(matchzyId);
  return row ? getMatch(row.id) : null;
}

export function saveMapScore(matchId, mapNumber, team1Score, team2Score, winner) {
  db.prepare(`
    INSERT INTO match_maps (match_id, map_number, team1_score, team2_score, winner) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (match_id, map_number) DO UPDATE SET
      team1_score = excluded.team1_score,
      team2_score = excluded.team2_score,
      winner = COALESCE(excluded.winner, winner)
  `).run(matchId, mapNumber, team1Score, team2Score, winner);
}

export function savePlayerStats(matchId, mapNumber, team, stats) {
  db.prepare(`
    INSERT OR REPLACE INTO player_map_stats
      (match_id, map_number, steam_id, team, name, kills, deaths, assists, headshot_kills, damage, rounds_played, mvp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    matchId, mapNumber, stats.steamId, team, stats.name, stats.kills, stats.deaths,
    stats.assists, stats.headshotKills, stats.damage, stats.roundsPlayed, stats.mvp,
  );
}

export function finishSeries(matchId, team1Series, team2Series, winner) {
  db.prepare(`
    UPDATE matches SET status = 'finished', send_error = NULL, team1_series = ?, team2_series = ?, winner = ? WHERE id = ?
  `).run(team1Series, team2Series, winner, matchId);
}

export const matchMaps = (matchId) => db.prepare(
  'SELECT * FROM match_maps WHERE match_id = ? ORDER BY map_number',
).all(matchId);

export const matchPlayerStats = (matchId) => db.prepare(
  'SELECT * FROM player_map_stats WHERE match_id = ? ORDER BY kills DESC',
).all(matchId);

const PLAYER_TOTALS = `
  SELECT s.steam_id, COALESCE(u.name, MAX(s.name)) AS name, u.avatar,
         COUNT(DISTINCT s.match_id) AS matches, COUNT(*) AS maps,
         SUM(s.kills) AS kills, SUM(s.deaths) AS deaths, SUM(s.assists) AS assists,
         SUM(s.headshot_kills) AS headshot_kills, SUM(s.damage) AS damage,
         SUM(s.rounds_played) AS rounds_played, SUM(s.mvp) AS mvp
  FROM player_map_stats s
  JOIN matches m ON m.id = s.match_id AND m.is_test = 0
  LEFT JOIN users u ON u.steam_id = s.steam_id
`;

export const leaderboard = () => db.prepare(`${PLAYER_TOTALS} GROUP BY s.steam_id ORDER BY kills DESC LIMIT 200`).all();

export const playerTotals = (steamId) => db.prepare(
  `${PLAYER_TOTALS} WHERE s.steam_id = ? GROUP BY s.steam_id`,
).get(steamId);

export function playerMaps(steamId) {
  return db.prepare(`
    SELECT s.*, t1.name AS team1_name, t2.name AS team2_name, mm.team1_score, mm.team2_score
    FROM player_map_stats s
    JOIN matches m ON m.id = s.match_id
    JOIN teams t1 ON t1.id = m.team1_id
    JOIN teams t2 ON t2.id = m.team2_id
    LEFT JOIN match_maps mm ON mm.match_id = s.match_id AND mm.map_number = s.map_number
    WHERE s.steam_id = ? AND m.is_test = 0 ORDER BY s.match_id DESC, s.map_number LIMIT 50
  `).all(steamId);
}

export function matchState(match) {
  return computeState({
    format: match.format,
    firstTeam: match.first_team,
    pool: match.pool,
    actions: vetoActions(match.id),
  });
}
