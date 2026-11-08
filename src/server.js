import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { config, findServer } from './config.js';
import * as store from './db.js';
import { handleEvent } from './events.js';
import { buildMatchConfig } from './matchzy.js';
import { getServerState, panelEnabled, setServerPower } from './panel.js';
import { sendRcon } from './rcon.js';
import { simulateMatch } from './simulate.js';
import { cookieHeader, createSession, parseCookies, readSession, seal, unseal } from './session.js';
import { fetchSteamProfile, steamLoginUrl, verifySteamLogin } from './steam.js';
import { MAP_NAMES, MAP_POOLS, finalMaps, minimumMaps, validateAction } from './veto.js';
import * as views from './views.js';

const PUBLIC_FILES = {
  '/style.css': 'text/css; charset=utf-8',
  '/match.js': 'text/javascript; charset=utf-8',
  '/copy.js': 'text/javascript; charset=utf-8',
  '/admin.js': 'text/javascript; charset=utf-8',
};
const publicDir = join(import.meta.dirname, '..', 'public');
const MAX_BODY = 256 * 1024;
const SEND_RETRY_MS = Number(process.env.SEND_RETRY_MS || 5000);
const SEND_ATTEMPTS = 60;
const MANUAL_HOLD_MS = 60 * 60 * 1000;

// Server power: when each server last had a reason to run, and any admin's manual start.
const lastNeeded = new Map();
const manualHolds = new Map();

// Starts the server if it's off. A panel problem is only logged, because the
// server may be running anyway and sending the match will still work.
async function powerOn(server) {
  if (!panelEnabled(server)) return;
  lastNeeded.set(server.id, Date.now());
  try {
    if ((await getServerState(server)) === 'offline') {
      console.log(`Starting ${server.id}`);
      await setServerPower(server, 'start');
    }
  } catch (err) {
    console.error(`Could not start ${server.id}: ${err.message}`);
  }
}

// Stops servers that have had no match and no manual start for a while.
async function stopIdleServers() {
  for (const server of config.servers.filter(panelEnabled)) {
    const now = Date.now();
    if (store.serverHasOpenMatch(server.id) || (manualHolds.get(server.id) || 0) > now) {
      lastNeeded.set(server.id, now);
      continue;
    }
    if (now - (lastNeeded.get(server.id) || now) < config.panelIdleMs) {
      if (!lastNeeded.has(server.id)) lastNeeded.set(server.id, now);
      continue;
    }
    const state = await getServerState(server);
    if (state === 'running' || state === 'starting') {
      try {
        console.log(`Stopping ${server.id}: nothing needs it`);
        await setServerPower(server, 'stop');
      } catch (err) {
        console.error(`Could not stop ${server.id}: ${err.message}`);
      }
    }
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const routes = [];
function route(method, path, handler) {
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`);
  routes.push({ method, pattern, handler });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'For mye data.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if ((req.headers['content-type'] || '').includes('application/json')) {
    try {
      return JSON.parse(text || '{}');
    } catch {
      throw new HttpError(400, 'Ugyldig forespørsel.');
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

function isLoopback(req) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
}

// Cookies are SameSite=Lax, and this also rejects form posts from other sites.
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'Ugyldig opprinnelse.');
  }
  if (host !== req.headers.host) throw new HttpError(403, 'Ugyldig opprinnelse.');
}

// Only allows paths on this site, so a login can't redirect somewhere else.
function safeNext(next) {
  return typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : '/';
}

function requireUser(ctx) {
  if (!ctx.user) throw new HttpError(401, 'Du må logge inn først.');
  return ctx.user;
}

function requireAdmin(ctx) {
  const user = requireUser(ctx);
  if (!user.is_admin) throw new HttpError(403, 'Bare administratorer kan gjøre dette.');
  return user;
}

function loadTeam(ctx) {
  const team = store.getTeam(Number(ctx.params.id));
  if (!team) throw new HttpError(404, 'Laget finnes ikke.');
  return team;
}

function loadMatch(ctx) {
  const match = store.getMatch(Number(ctx.params.id));
  if (!match) throw new HttpError(404, 'Kampen finnes ikke.');
  return match;
}

function requireCaptain(ctx, team) {
  if (requireUser(ctx).steam_id !== team.captain_id) {
    throw new HttpError(403, 'Bare kapteinen kan gjøre dette.');
  }
}

function requireUnlocked(team) {
  if (store.teamHasOpenMatch(team.id)) {
    throw new HttpError(409, 'Laget er låst så lenge det har en kamp som ikke er ferdig.');
  }
}

// In a test match the admin who made it always plays on team 1. On the hidden test team,
// each human takes a bot's place, so the team stays the right size.
function team1Players(match) {
  const members = store.teamMembers(match.team1_id);
  const tester = match.is_test ? store.getUser(match.created_by) : null;
  if (!tester || members.some((m) => m.steam_id === tester.steam_id)) return members;

  const players = [tester, ...members];
  if (!store.getTeam(match.team1_id).is_test) return players;
  return players.slice(0, findServer(match.server_id)?.mode === '5v5' ? 5 : 2);
}

// The admin playing a test match shows as captain of the hidden test team.
function testTeam1View(match) {
  const team = store.getTeam(match.team1_id);
  return team.is_test && match.created_by ? { ...team, captain_id: match.created_by } : team;
}

// Sessions and login

route('GET', '/auth/steam', (ctx) => {
  const state = randomBytes(16).toString('base64url');
  const next = safeNext(ctx.query.get('next'));
  const cookie = cookieHeader('login', seal(JSON.stringify({ state, next })), 600);
  const returnTo = `${config.baseUrl}/auth/steam/callback?state=${state}`;
  ctx.redirect(steamLoginUrl(returnTo, config.baseUrl), [cookie]);
});

route('GET', '/auth/steam/callback', async (ctx) => {
  const sealed = unseal(ctx.cookies.login);
  const login = sealed ? JSON.parse(sealed) : null;
  if (!login || login.state !== ctx.query.get('state')) {
    throw new HttpError(400, 'Innloggingen gikk ut. Prøv igjen.');
  }

  const returnTo = `${config.baseUrl}/auth/steam/callback?state=${login.state}`;
  const steamId = await verifySteamLogin(ctx.query, returnTo);
  if (!steamId) throw new HttpError(400, 'Steam kunne ikke bekrefte innloggingen. Prøv igjen.');

  const profile = await fetchSteamProfile(steamId);
  store.upsertUser(steamId, profile, config.adminSteamIds.includes(steamId));
  ctx.redirect(login.next, [createSession(steamId), cookieHeader('login', '', 0)]);
});

route('POST', '/auth/logout', (ctx) => {
  ctx.redirect('/', [cookieHeader('session', '', 0)]);
});

// Lets two browsers act as different players while testing. Never reachable remotely.
route('GET', '/dev-login', (ctx) => {
  if (!config.devLogin || !isLoopback(ctx.req)) throw new HttpError(404, 'Siden finnes ikke.');
  const steamId = ctx.query.get('steam');
  if (!/^\d{17}$/.test(steamId || '')) throw new HttpError(400, 'Ugyldig SteamID.');
  store.upsertUser(steamId, { name: ctx.query.get('name'), avatar: null }, ctx.query.get('admin') === '1');
  ctx.redirect(safeNext(ctx.query.get('next')), [createSession(steamId)]);
});

// Pages

route('GET', '/', (ctx) => {
  ctx.html(views.homePage({
    user: ctx.user,
    team: ctx.user ? store.getUserTeam(ctx.user.steam_id) : null,
    matches: store.listMatches(),
    flash: ctx.flash,
  }));
});

route('GET', '/teams', (ctx) => {
  ctx.html(views.teamsPage({ user: ctx.user, teams: store.listTeams(), flash: ctx.flash }));
});

route('POST', '/teams', async (ctx) => {
  const user = requireUser(ctx);
  const name = String((await ctx.body()).name || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 32) return ctx.back('/', 'Lagnavnet må ha mellom 2 og 32 tegn.');
  if (store.getUserTeam(user.steam_id)) return ctx.back('/', 'Du er allerede på et lag.');
  if (store.getTeamByName(name)) return ctx.back('/', 'Det navnet er allerede tatt.');
  ctx.redirect(`/teams/${store.createTeam(name, user.steam_id)}`);
});

route('GET', '/teams/:id', (ctx) => {
  const team = loadTeam(ctx);
  ctx.html(views.teamPage({
    user: ctx.user,
    team,
    members: store.teamMembers(team.id),
    inviteUrl: `${config.baseUrl}/join/${team.invite_token}`,
    locked: store.teamHasOpenMatch(team.id),
    flash: ctx.flash,
  }));
});

route('POST', '/teams/:id/invite', (ctx) => {
  const team = loadTeam(ctx);
  requireCaptain(ctx, team);
  store.newInvite(team.id);
  ctx.back(`/teams/${team.id}`, 'Ny lenke er laget. Den gamle virker ikke lenger.');
});

route('POST', '/teams/:id/captain', async (ctx) => {
  const team = loadTeam(ctx);
  requireCaptain(ctx, team);
  requireUnlocked(team);
  const { steam_id: steamId } = await ctx.body();
  if (!store.teamMembers(team.id).some((m) => m.steam_id === steamId)) {
    return ctx.back(`/teams/${team.id}`, 'Spilleren er ikke på laget.');
  }
  store.setCaptain(team.id, steamId);
  ctx.redirect(`/teams/${team.id}`);
});

route('POST', '/teams/:id/remove', async (ctx) => {
  const team = loadTeam(ctx);
  requireCaptain(ctx, team);
  requireUnlocked(team);
  const { steam_id: steamId } = await ctx.body();
  if (steamId === team.captain_id) return ctx.back(`/teams/${team.id}`, 'Gi kapteinsrollen til noen andre først.');
  store.removeMember(team.id, steamId);
  ctx.redirect(`/teams/${team.id}`);
});

route('POST', '/teams/:id/leave', (ctx) => {
  const team = loadTeam(ctx);
  const user = requireUser(ctx);
  requireUnlocked(team);
  if (user.steam_id === team.captain_id) return ctx.back(`/teams/${team.id}`, 'Gi kapteinsrollen til noen andre først.');
  store.removeMember(team.id, user.steam_id);
  ctx.redirect('/');
});

route('GET', '/join/:token', (ctx) => {
  const team = store.getTeamByInvite(ctx.params.token);
  if (!team) throw new HttpError(404, 'Lenken virker ikke lenger. Be kapteinen om en ny.');
  ctx.html(views.joinPage({
    user: ctx.user,
    team,
    memberCount: store.teamMembers(team.id).length,
    currentTeam: ctx.user ? store.getUserTeam(ctx.user.steam_id) : null,
    flash: ctx.flash,
  }));
});

route('POST', '/join/:token', (ctx) => {
  const user = requireUser(ctx);
  const team = store.getTeamByInvite(ctx.params.token);
  if (!team) throw new HttpError(404, 'Lenken virker ikke lenger. Be kapteinen om en ny.');
  requireUnlocked(team);
  if (store.getUserTeam(user.steam_id)) return ctx.back(`/join/${ctx.params.token}`, 'Du er allerede på et lag.');
  store.addMember(team.id, user.steam_id);
  ctx.redirect(`/teams/${team.id}`);
});

// Admin

function loadPanelServer(ctx) {
  requireAdmin(ctx);
  const server = findServer(ctx.params.id);
  if (!panelEnabled(server)) throw new HttpError(404, 'Serveren er ikke koblet til panelet.');
  return server;
}

route('POST', '/admin/servers/:id/start', async (ctx) => {
  const server = loadPanelServer(ctx);
  manualHolds.set(server.id, Date.now() + MANUAL_HOLD_MS);
  lastNeeded.set(server.id, Date.now());
  try {
    await setServerPower(server, 'start');
    ctx.back('/admin', `${server.name} starter. Den holdes på i minst en time.`);
  } catch (err) {
    ctx.back('/admin', `Kunne ikke starte ${server.name}: ${err.message}`);
  }
});

route('POST', '/admin/servers/:id/stop', async (ctx) => {
  const server = loadPanelServer(ctx);
  if (store.serverHasOpenMatch(server.id)) {
    return ctx.back('/admin', `${server.name} har en kamp som ikke er ferdig. Avslutt kampen først.`);
  }
  manualHolds.delete(server.id);
  try {
    await setServerPower(server, 'stop');
    ctx.back('/admin', `${server.name} stopper.`);
  } catch (err) {
    ctx.back('/admin', `Kunne ikke stoppe ${server.name}: ${err.message}`);
  }
});

route('GET', '/admin', async (ctx) => {
  requireAdmin(ctx);
  const serverStates = await Promise.all(config.servers.map(async (server) => ({
    id: server.id,
    name: server.name,
    canPower: panelEnabled(server),
    state: await getServerState(server),
  })));
  const users = store.listUsers();
  const userNames = new Map(users.map((u) => [u.steam_id, u.name]));
  const teamNames = store.userTeamNames();
  ctx.html(views.adminPage({
    user: ctx.user,
    serverStates,
    teams: store.listTeams().map((team) => ({
      ...team,
      captainName: userNames.get(team.captain_id) || '',
      memberCount: store.teamMembers(team.id).length,
      locked: store.teamHasOpenMatch(team.id),
    })),
    servers: config.servers,
    matches: store.listMatches({ includeTests: true, limit: 1000 }),
    users: users.map((u) => ({ ...u, teamName: teamNames.get(u.steam_id) || '' })),
    flash: ctx.flash,
  }));
});

route('POST', '/admin/teams/:id/delete', (ctx) => {
  requireAdmin(ctx);
  const team = loadTeam(ctx);
  if (store.teamHasOpenMatch(team.id)) {
    return ctx.back('/admin', `${team.name} har en kamp som ikke er ferdig. Merk den som ferdig først.`);
  }
  store.deleteTeam(team.id);
  ctx.back('/admin', `${team.name} er slettet.`);
});

route('POST', '/admin/users', async (ctx) => {
  const admin = requireAdmin(ctx);
  const { steam_id: steamId, admin: makeAdmin } = await ctx.body();
  if (steamId === admin.steam_id) return ctx.back('/admin', 'Du kan ikke endre din egen admin-rolle.');
  if (!store.getUser(steamId)) return ctx.back('/admin', 'Fant ikke brukeren.');
  store.setAdmin(steamId, makeAdmin === '1');
  ctx.redirect('/admin');
});

route('POST', '/matches', async (ctx) => {
  requireAdmin(ctx);
  const form = await ctx.body();
  const team1 = store.getTeam(Number(form.team1));
  const team2 = store.getTeam(Number(form.team2));
  const server = findServer(form.server);
  const format = form.format === 'bo1' ? 'bo1' : 'bo3';

  if (!team1 || !team2 || !server) return ctx.back('/admin', 'Velg to lag og en server.');
  if (team1.id === team2.id) return ctx.back('/admin', 'Et lag kan ikke spille mot seg selv.');
  if (store.teamHasOpenMatch(team1.id) || store.teamHasOpenMatch(team2.id)) {
    return ctx.back('/admin', 'Et av lagene har allerede en kamp som ikke er ferdig.');
  }
  for (const team of [team1, team2]) {
    if (store.teamMembers(team.id).length < server.playersPerTeam) {
      return ctx.back('/admin', `${team.name} trenger minst ${server.playersPerTeam} spillere på denne serveren.`);
    }
  }
  if (MAP_POOLS[server.mode].length < minimumMaps(format)) {
    return ctx.back('/admin', 'Det er ikke nok kart for dette formatet.');
  }

  const firstTeam = form.first === '1' ? 1 : form.first === '2' ? 2 : randomBytes(1)[0] % 2 + 1;
  const id = store.createMatch({ team1Id: team1.id, team2Id: team2.id, format, server, firstTeam });
  powerOn(server);
  ctx.redirect(`/matches/${id}`);
});

route('POST', '/matches/test', async (ctx) => {
  const admin = requireAdmin(ctx);
  const form = await ctx.body();
  const server = findServer(form.server);
  if (!server) return ctx.back('/admin', 'Velg en server.');

  const [testTeam1, testTeam2] = store.testTeams();
  const botsOnly = form.team === 'bots';
  const realTeam = form.team && !botsOnly ? store.getTeam(Number(form.team)) : null;
  if (realTeam && store.teamHasOpenMatch(realTeam.id)) {
    return ctx.back('/admin', `${realTeam.name} har allerede en kamp som ikke er ferdig.`);
  }

  const id = store.createMatch({
    team1Id: realTeam ? realTeam.id : testTeam1,
    team2Id: testTeam2,
    format: form.format === 'bo1' ? 'bo1' : 'bo3',
    server,
    firstTeam: randomBytes(1)[0] % 2 + 1,
    isTest: true,
    // Nobody plays in a bots-only match, which is what the missing player marks.
    createdBy: botsOnly ? null : admin.steam_id,
  });
  powerOn(server);
  ctx.redirect(`/matches/${id}`);
});

// Matches

route('GET', '/matches/:id', (ctx) => {
  const match = loadMatch(ctx);
  ctx.html(views.matchPage({
    user: ctx.user,
    match,
    team1: testTeam1View(match),
    team2: store.getTeam(match.team2_id),
    members1: team1Players(match),
    members2: store.teamMembers(match.team2_id),
    matchUrl: `${config.baseUrl}/matches/${match.id}`,
    flash: ctx.flash,
  }));
});

function describeMatch(match, user) {
  const team1 = store.getTeam(match.team1_id);
  const team2 = store.getTeam(match.team2_id);
  const server = findServer(match.server_id);
  const state = store.matchState(match);
  const teamName = (n) => (n === 1 ? team1.name : team2.name);

  const yourTeam = user?.steam_id === team1.captain_id ? 1 : user?.steam_id === team2.captain_id ? 2 : null;
  const yourTurn = match.status === 'veto' && Boolean(state.current)
    && (state.current.team === yourTeam || Boolean(match.is_test && user?.is_admin));

  const mapStatus = (map) => {
    const ban = state.banned.find((b) => b.map === map);
    if (ban) return { state: 'banned', by: teamName(ban.team) };
    const pick = state.picks.find((p) => p.map === map);
    if (pick) return { state: 'picked', by: pick.team ? teamName(pick.team) : null };
    if (state.decider === map) return { state: 'decider' };
    return { state: 'open' };
  };

  return {
    status: match.status,
    isTest: Boolean(match.is_test),
    botsOnly: Boolean(match.is_test && !match.created_by),
    statusText: views.STATUS_TEXT[match.status],
    sendError: match.status === 'send_failed' ? match.send_error : null,
    current: state.current && {
      action: state.current.action,
      team: state.current.team,
      teamName: teamName(state.current.team),
      mapName: state.current.map ? MAP_NAMES[state.current.map] : null,
    },
    yourTurn,
    maps: match.pool.map((map) => ({ map, name: MAP_NAMES[map] || map, ...mapStatus(map) })),
    series: describeSeries(match, teamName),
    scoreboards: state.done ? describeScoreboards(match, state, teamName) : [],
    log: describeLog(state, teamName),
    summary: state.done ? describeSummary(match, state, teamName) : null,
    connect: match.status === 'sent' && server
      ? { url: `steam://connect/${server.host}:${server.port}`, command: `connect ${server.host}:${server.port}` }
      : null,
    watch: describeWatch(match, server, user),
  };
}

// Only admins get the GOTV address and password.
function describeWatch(match, server, user) {
  if (match.status !== 'sent' || !server?.gotvPort || !user?.is_admin) return null;
  const address = `${server.host}:${server.gotvPort}`;
  const password = server.gotvPassword ? `password ${server.gotvPassword}; ` : '';
  return { command: `${password}connect ${address}` };
}

function describeSeries(match, teamName) {
  const maps = store.matchMaps(match.id);
  if (match.team1_series === null && maps.length === 0) return null;

  // While the series runs, the score comes from the maps finished so far.
  const wins = (team) => maps.filter((m) => m.winner === team).length;
  const finished = match.team1_series !== null;
  let result = null;
  if (finished) {
    if (match.winner === 'team1') result = `${teamName(1)} vant`;
    else if (match.winner === 'team2') result = `${teamName(2)} vant`;
    // MatchZy also reports a stopped match as a series with no winner.
    else result = match.team1_series === 0 && match.team2_series === 0 ? 'Kampen ble avbrutt' : 'Uavgjort';
  } else if (match.status === 'finished') {
    result = 'Kampen ble avbrutt';
  }
  return {
    team1: finished ? match.team1_series : wins('team1'),
    team2: finished ? match.team2_series : wins('team2'),
    result,
  };
}

// One row per player, added up when the row covers several maps.
function describePlayers(rows, avatars) {
  const players = new Map();
  for (const s of rows) {
    const p = players.get(s.steam_id) || {
      steamId: s.steam_id, name: s.name, kills: 0, deaths: 0, assists: 0, headshots: 0, damage: 0, rounds: 0,
    };
    p.kills += s.kills;
    p.deaths += s.deaths;
    p.assists += s.assists;
    p.headshots += s.headshot_kills;
    p.damage += s.damage;
    p.rounds += s.rounds_played;
    players.set(s.steam_id, p);
  }

  return [...players.values()]
    .map((p) => {
      const user = avatars.get(p.steamId);
      return {
        steamId: p.steamId,
        name: user?.name || p.name,
        avatar: user?.avatar || null,
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
        headshotPercent: views.percent(p.headshots, p.kills),
        adr: views.perRound(p.damage, p.rounds),
        rating: views.rating(p.kills, p.deaths, p.damage, p.rounds),
      };
    })
    .sort((a, b) => b.rating - a.rating);
}

function describeScoreboards(match, state, teamName) {
  const names = finalMaps(state).map((entry) => MAP_NAMES[entry.map] || entry.map);
  const stats = store.matchPlayerStats(match.id);
  const maps = store.matchMaps(match.id);
  const avatars = new Map(
    [...new Set(stats.map((s) => s.steam_id))].map((id) => [id, store.getUser(id)]),
  );

  const boards = maps.map((map) => {
    const team = (number) => ({
      number,
      name: teamName(number),
      score: number === 1 ? map.team1_score : map.team2_score,
      won: map.winner === `team${number}`,
      players: describePlayers(stats.filter((s) => s.map_number === map.map_number && s.team === number), avatars),
    });
    return { name: names[map.map_number] || `Kart ${map.map_number + 1}`, teams: [team(1), team(2)] };
  });
  if (maps.length < 2) return boards;

  const total = (number) => ({
    number,
    name: teamName(number),
    score: maps.reduce((sum, m) => sum + (number === 1 ? m.team1_score : m.team2_score), 0),
    won: false,
    players: describePlayers(stats.filter((s) => s.team === number), avatars),
  });
  return [{ name: 'Hele serien', teams: [total(1), total(2)] }, ...boards];
}

// The match card: sides until a map is played, then the score.
function describeSummary(match, state, teamName) {
  const results = store.matchMaps(match.id);
  const series = describeSeries(match, teamName);
  const over = match.status === 'finished';
  let nextMarked = false;

  const maps = finalMaps(state).map((entry, mapNumber) => {
    const result = results.find((r) => r.map_number === mapNumber);
    const [sideTeam, side] = entry.side.split('_');
    const team1Side = entry.side === 'knife' ? null : (sideTeam === 'team1' ? side : (side === 'ct' ? 't' : 'ct'));

    let status = 'waiting';
    if (result?.winner) status = 'finished';
    else if (result) status = over ? 'stopped' : 'live';
    else if (over) status = 'unused';
    else if (!nextMarked) {
      status = 'next';
      nextMarked = true;
    }

    return {
      map: entry.map,
      name: MAP_NAMES[entry.map] || entry.map,
      status,
      team1Side,
      team1Score: result?.team1_score ?? null,
      team2Score: result?.team2_score ?? null,
      winner: result?.winner ?? null,
    };
  });

  return {
    team1: teamName(1),
    team2: teamName(2),
    played: results.filter((r) => r.winner).length,
    total: maps.length,
    seriesTeam1: series?.team1 ?? 0,
    seriesTeam2: series?.team2 ?? 0,
    roundsTeam1: results.reduce((sum, r) => sum + r.team1_score, 0),
    roundsTeam2: results.reduce((sum, r) => sum + r.team2_score, 0),
    maps,
  };
}

// The vote history. A side choice is shown on the map it belongs to.
function describeLog(state, teamName) {
  const rows = [];
  const sideNote = (entry) => `${teamName(entry.team)} starter som ${entry.side.toUpperCase()}`;

  for (const entry of state.history) {
    if (entry.action === 'side') {
      const row = rows.find((r) => r.map === entry.map);
      if (row) row.note = sideNote(entry);
      else rows.push({ type: 'decider', map: entry.map, name: MAP_NAMES[entry.map], note: sideNote(entry) });
    } else {
      rows.push({
        type: entry.action,
        map: entry.map,
        name: MAP_NAMES[entry.map],
        team: entry.team,
        teamName: teamName(entry.team),
      });
    }
  }
  if (state.decider) {
    rows.push({ type: 'decider', map: state.decider, name: MAP_NAMES[state.decider], note: 'Knivrunde avgjør sidene' });
  }
  return rows;
}

route('GET', '/api/matches/:id', (ctx) => {
  ctx.json(describeMatch(loadMatch(ctx), ctx.user));
});

route('POST', '/api/matches/:id/veto', async (ctx) => {
  const user = requireUser(ctx);
  const match = loadMatch(ctx);
  const { value } = await ctx.body();
  if (match.status !== 'veto') throw new HttpError(409, 'Kartvalget er allerede ferdig.');

  const team1 = store.getTeam(match.team1_id);
  const team2 = store.getTeam(match.team2_id);
  const state = store.matchState(match);

  // In a test match an admin plays both sides.
  let team = user.steam_id === team1.captain_id ? 1 : user.steam_id === team2.captain_id ? 2 : null;
  if (match.is_test && user.is_admin) team = state.current?.team ?? null;
  if (!team) throw new HttpError(403, 'Bare kapteinene kan velge kart.');

  const error = validateAction(state, team, value);
  if (error) throw new HttpError(409, error);

  store.addVetoAction(match.id, store.vetoActions(match.id).length, value, user.steam_id);
  if (store.matchState(match).done) startSending(match);
  ctx.json(describeMatch(store.getMatch(match.id), user));
});

function loadTestMatch(ctx) {
  requireAdmin(ctx);
  const match = loadMatch(ctx);
  if (!match.is_test) throw new HttpError(403, 'Dette er bare for testkamper.');
  return match;
}

// Fills the match with random results, without needing a server.
route('POST', '/matches/:id/simulate', async (ctx) => {
  const match = loadTestMatch(ctx);
  const state = store.matchState(match);
  if (!state.done) return ctx.back(`/matches/${match.id}`, 'Fullfør kartvalget først.');
  await releaseServer(match);
  simulateMatch({
    match,
    state,
    members1: team1Players(match),
    members2: store.teamMembers(match.team2_id),
  });
  ctx.redirect(`/matches/${match.id}`);
});

async function testCommand(ctx, command, message) {
  const match = loadTestMatch(ctx);
  const server = findServer(match.server_id);
  if (match.status !== 'sent') return ctx.back(`/matches/${match.id}`, 'Send kampen til serveren først.');
  try {
    await sendRcon({
      host: server.rconHost || server.host,
      port: server.rconPort || server.port,
      password: server.rconPassword,
      command,
    });
    ctx.back(`/matches/${match.id}`, message);
  } catch (err) {
    ctx.back(`/matches/${match.id}`, `Serveren svarte ikke: ${err.message}`);
  }
}

route('POST', '/matches/:id/test-start', (ctx) => testCommand(ctx, 'css_start', 'Kampen er bedt om å starte.'));

async function sendToServer(match) {
  const server = findServer(match.server_id);
  if (!server) {
    store.setMatchStatus(match.id, 'send_failed', 'Serveren finnes ikke lenger i oppsettet.');
    return;
  }
  if (store.serverBusyWith(server.id, match.id)) {
    store.setMatchStatus(match.id, 'send_failed', 'Serveren er opptatt med en annen kamp.');
    return;
  }

  if (!server.rconPassword) {
    store.setMatchStatus(match.id, 'send_failed', 'Serveren mangler RCON-passord i oppsettet.');
    return;
  }

  store.setMatchStatus(match.id, 'sending');
  await powerOn(server);
  const url = `${config.baseUrl}/matchzy/${match.id}/${match.config_token}.json`;

  // A server that's starting up refuses connections for a while, so keep trying.
  for (let attempt = 1; ; attempt += 1) {
    if (store.getMatch(match.id)?.status !== 'sending') return;
    try {
      await sendRcon({
        host: server.rconHost || server.host,
        port: server.rconPort || server.port,
        password: server.rconPassword,
        command: `matchzy_loadmatch_url "${url}"`,
      });
      if (store.getMatch(match.id)?.status === 'sending') store.setMatchStatus(match.id, 'sent');
      return;
    } catch (err) {
      // A server that's still starting also rejects the password, until it has read its config.
      const canRetry = attempt < SEND_ATTEMPTS;
      console.error(`Match ${match.id}: attempt ${attempt} to send to ${server.id} failed: ${err.message}`);
      if (!canRetry) {
        if (store.getMatch(match.id)?.status === 'sending') store.setMatchStatus(match.id, 'send_failed', err.message);
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, SEND_RETRY_MS));
  }
}

// Sends in the background, so nobody's click has to wait for a server that's starting.
function startSending(match) {
  sendToServer(match).catch((err) => {
    console.error(`Match ${match.id}: ${err.message}`);
    store.setMatchStatus(match.id, 'send_failed', 'Noe gikk galt under sendingen.');
  });
}

route('POST', '/matches/:id/send', (ctx) => {
  requireAdmin(ctx);
  const match = loadMatch(ctx);
  if (!store.matchState(match).done) return ctx.back(`/matches/${match.id}`, 'Kartvalget er ikke ferdig ennå.');
  if (match.status === 'sending') return ctx.back(`/matches/${match.id}`, 'Kampen sendes allerede.');
  startSending(match);
  ctx.redirect(`/matches/${match.id}`);
});

// Ends a match still loaded on the server, which also closes the server again.
// A failure is only logged, so the site can still move on.
async function releaseServer(match) {
  const server = findServer(match.server_id);
  if (match.status !== 'sent' || !server?.rconPassword) return;
  try {
    await sendRcon({
      host: server.rconHost || server.host,
      port: server.rconPort || server.port,
      password: server.rconPassword,
      command: 'css_restart',
    });
  } catch (err) {
    console.error(`Match ${match.id}: could not release ${server.id}: ${err.message}`);
  }
}

route('POST', '/matches/:id/finish', async (ctx) => {
  requireAdmin(ctx);
  const match = loadMatch(ctx);
  await releaseServer(match);
  store.setMatchStatus(match.id, 'finished');
  ctx.redirect(`/matches/${match.id}`);
});

route('POST', '/matches/:id/delete', async (ctx) => {
  requireAdmin(ctx);
  const match = loadMatch(ctx);
  await releaseServer(match);
  store.deleteMatch(match.id);
  ctx.back('/admin', 'Kampen er slettet.');
});

// What MatchZy downloads. The long random token in the address is what protects it.
route('GET', '/matchzy/:id/:token.json', (ctx) => {
  const match = loadMatch(ctx);
  if (ctx.params.token !== match.config_token) throw new HttpError(404, 'Siden finnes ikke.');
  const state = store.matchState(match);
  if (!state.done) throw new HttpError(409, 'Kartvalget er ikke ferdig ennå.');

  // One player is enough to start a test match.
  const server = findServer(match.server_id);
  ctx.json(buildMatchConfig({
    match,
    team1: store.getTeam(match.team1_id),
    team2: store.getTeam(match.team2_id),
    members1: team1Players(match),
    members2: store.teamMembers(match.team2_id),
    admins: store.listUsers().filter((u) => u.is_admin),
    state,
    server: match.is_test ? { ...server, playersPerTeam: 1 } : server,
  }));
});

// The shared key proves that a request comes from our game servers.
function requireServerKey(ctx) {
  const given = Buffer.from(String(ctx.req.headers['x-ranalan-key'] || ''));
  const expected = Buffer.from(config.eventsKey);
  if (!expected.length || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new HttpError(403, 'Ugyldig nøkkel.');
  }
}

// Where MatchZy posts its events.
route('POST', '/matchzy/events', async (ctx) => {
  requireServerKey(ctx);
  handleEvent(await ctx.body());
  ctx.json({ ok: true });
});

// Asked by the RanalanGate plugin for each player on the server.
route('GET', '/matchzy/access', (ctx) => {
  requireServerKey(ctx);
  const server = ctx.query.get('server');
  ctx.json({
    allowed: store.mayJoinServer(server, ctx.query.get('steam')),
    matchLoaded: store.serverHasLoadedMatch(server),
  });
});

// Asked by the plugin every few seconds. Bots only play while a test match is loaded.
route('GET', '/matchzy/server', (ctx) => {
  requireServerKey(ctx);
  const server = findServer(ctx.query.get('server'));
  const test = server ? store.loadedTestMatch(server.id) : null;
  if (!test) return ctx.json({ testBotQuota: 0, testPlayers: [], botsOnly: false });

  // Everyone who should be playing, so anyone stuck in spectators can be moved to their team.
  const players = store.teamMembers(test.team1_id).map((m) => m.steam_id);
  if (test.created_by) players.push(test.created_by);
  ctx.json({
    testBotQuota: server.mode === 'wingman' ? 4 : 10,
    testPlayers: test.created_by ? players : [],
    botsOnly: !test.created_by,
  });
});

// MatchZy leaves bots out of its stats, so in test matches the plugin reports them itself.
route('POST', '/matchzy/bot-stats', async (ctx) => {
  requireServerKey(ctx);
  const body = await ctx.body();
  const server = findServer(body.server);
  const test = server ? store.loadedTestMatch(server.id) : null;
  if (!test || !Array.isArray(body.bots)) return ctx.json({ ok: false });

  const maps = store.matchMaps(test.id);
  const mapNumber = maps.length ? maps.at(-1).map_number : 0;

  // With no humans to compare against, a bot's team comes from the side it first played.
  // After that it keeps its team, also when the sides swap at halftime.
  const known = store.matchPlayerStats(test.id).filter((s) => s.map_number === mapNumber);
  const startSide = finalMaps(store.matchState(store.getMatch(test.id)))[mapNumber]?.side || '';
  const team1Starts = startSide === 'team1_t' || startSide === 'team2_ct' ? 't' : 'ct';
  const teamOf = (bot) => {
    if (bot.team === 1 || bot.team === 2) return bot.team;
    const before = known.find((s) => s.steam_id === `BOT-${String(bot.name).slice(0, 40)}`);
    if (before) return before.team;
    return bot.side === team1Starts ? 1 : 2;
  };

  for (const bot of body.bots) {
    store.savePlayerStats(test.id, mapNumber, teamOf(bot), {
      steamId: `BOT-${String(bot.name).slice(0, 40)}`,
      name: `BOT ${String(bot.name).slice(0, 40)}`,
      kills: Number(bot.kills) || 0,
      deaths: Number(bot.deaths) || 0,
      assists: Number(bot.assists) || 0,
      headshotKills: Number(bot.headshots) || 0,
      damage: Number(bot.damage) || 0,
      roundsPlayed: Number(bot.rounds) || 0,
      mvp: 0,
    });
  }
  ctx.json({ ok: true });
});

// Stats

route('GET', '/stats', (ctx) => {
  ctx.html(views.statsPage({ user: ctx.user, players: store.leaderboard(), flash: ctx.flash }));
});

route('GET', '/players/:id', (ctx) => {
  const totals = store.playerTotals(ctx.params.id);
  if (!totals) throw new HttpError(404, 'Spilleren har ingen statistikk ennå.');

  const maps = store.playerMaps(ctx.params.id).map((row) => {
    const entry = finalMaps(store.matchState(store.getMatch(row.match_id)))[row.map_number];
    return { ...row, mapName: entry ? MAP_NAMES[entry.map] : `Kart ${row.map_number + 1}` };
  });
  ctx.html(views.playerPage({ user: ctx.user, player: totals, maps, flash: ctx.flash }));
});

// Request handling

function makeContext(req, res, url, params) {
  const cookies = parseCookies(req.headers.cookie);
  const steamId = readSession(cookies);
  const flashValue = unseal(cookies.flash);
  const extraCookies = flashValue ? [cookieHeader('flash', '', 0)] : [];

  const send = (status, type, body, headers = {}) => {
    res.writeHead(status, {
      'Content-Type': type,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      ...(extraCookies.length ? { 'Set-Cookie': extraCookies } : {}),
      ...headers,
    });
    res.end(body);
  };

  const ctx = {
    req,
    params,
    cookies,
    query: url.searchParams,
    user: steamId ? store.getUser(steamId) : null,
    flash: flashValue,
    body: () => readBody(req),
    html: (body, status = 200) => send(status, 'text/html; charset=utf-8', body),
    json: (data, status = 200) => send(status, 'application/json; charset=utf-8', JSON.stringify(data), {
      'Cache-Control': 'no-store',
    }),
    redirect: (location, cookiesToSet = []) => {
      res.writeHead(303, { Location: location, 'Set-Cookie': [...extraCookies, ...cookiesToSet] });
      res.end();
    },
    back: (location, message) => {
      ctx.redirect(location, [cookieHeader('flash', seal(message), 60)]);
    },
  };
  return ctx;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && PUBLIC_FILES[url.pathname]) {
    res.writeHead(200, { 'Content-Type': PUBLIC_FILES[url.pathname], 'Cache-Control': 'no-cache' });
    res.end(readFileSync(join(publicDir, url.pathname)));
    return;
  }

  // Map screenshots. The strict pattern keeps requests inside the maps folder.
  const mapImage = req.method === 'GET' && /^\/maps\/(de_[a-z0-9]+)\.jpg$/.exec(url.pathname);
  if (mapImage) {
    const file = join(publicDir, 'maps', `${mapImage[1]}.jpg`);
    if (!existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' });
    res.end(readFileSync(file));
    return;
  }

  let ctx = makeContext(req, res, url, {});
  try {
    if (req.method === 'POST') checkOrigin(req);
    const found = routes
      .filter((r) => r.method === req.method)
      .map((r) => ({ handler: r.handler, match: r.pattern.exec(url.pathname) }))
      .find((r) => r.match);
    if (!found) throw new HttpError(404, 'Siden finnes ikke.');
    ctx = makeContext(req, res, url, found.match.groups || {});
    await found.handler(ctx);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    const message = err.status ? err.message : 'Prøv igjen om litt.';
    if (res.headersSent) {
      res.end();
    } else if (url.pathname.startsWith('/api/')) {
      ctx.json({ error: message }, status);
    } else if (status === 401) {
      ctx.redirect(`/auth/steam?next=${encodeURIComponent(req.method === 'GET' ? url.pathname : '/')}`);
    } else {
      ctx.html(views.errorPage({ user: ctx.user, status, message }), status);
    }
  }
}

createServer(handle).listen(config.port, config.host, () => {
  console.log(`Ranalan is running on ${config.baseUrl} with ${config.servers.length} server(s) configured`);
  if (config.devLogin) console.log('Test login is on (only reachable from this machine)');

  // Sending stops if the site restarts, so pick up anything that was still on its way.
  store.matchesBeingSent().forEach(startSending);

  setInterval(() => {
    stopIdleServers().catch((err) => console.error(`Idle server check failed: ${err.message}`));
  }, config.panelCheckMs).unref();
});
