const root = document.getElementById('match');
const matchId = root.dataset.id;
const turnEl = document.getElementById('turn');
const errorEl = document.getElementById('error');
const mapsEl = document.getElementById('maps');
const sidesEl = document.getElementById('sides');
const logEl = document.getElementById('log');
const resultEl = document.getElementById('result');

let lastRendered = '';
let busy = false;

const ACTION_TEXT = { ban: 'fjerne et kart', pick: 'velge et kart', side: 'velge side' };
const STATE_TEXT = { banned: 'Fjernet', picked: 'Valgt', decider: 'Avgjørende kart' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showError(message) {
  errorEl.textContent = message || '';
  errorEl.hidden = !message;
}

async function act(value) {
  if (busy) return;
  busy = true;
  showError('');
  try {
    const response = await fetch(`/api/matches/${matchId}/veto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    const data = await response.json();
    if (!response.ok) showError(data.error);
    else render(data);
  } catch {
    showError('Fikk ikke kontakt med siden. Prøv igjen.');
  } finally {
    busy = false;
    refresh();
  }
}

function renderTurn(data) {
  for (const number of [1, 2]) {
    document.getElementById(`team-panel-${number}`)
      .classList.toggle('active', data.current?.team === number);
  }
  if (data.current) {
    const what = data.current.action === 'side'
      ? `velge side på ${data.current.mapName}`
      : ACTION_TEXT[data.current.action];
    turnEl.textContent = data.yourTurn ? `Din tur: ${what}` : `${data.current.teamName} skal ${what}`;
    turnEl.classList.toggle('your-turn', data.yourTurn);
  } else {
    turnEl.textContent = data.series?.result || data.statusText;
    turnEl.classList.remove('your-turn');
  }

  const score = document.getElementById('series-score');
  score.hidden = !data.series;
  if (data.series) score.textContent = `${data.series.team1} - ${data.series.team2}`;
}

function teamBadge(name) {
  return el('span', 'team-badge', (name || '?').replace(/^TEST /, '').slice(0, 1).toUpperCase());
}

function playerAvatar(player) {
  if (player.avatar) {
    const image = el('img', 'avatar small');
    image.src = player.avatar;
    image.alt = '';
    return image;
  }
  return el('span', 'avatar small', (player.name || '?').slice(0, 1).toUpperCase());
}

function ratingClass(rating) {
  if (rating >= 1.05) return 'rating-good';
  return rating >= 0.85 ? 'rating-ok' : 'rating-bad';
}

function adrClass(adr) {
  if (adr >= 80) return 'rating-good';
  return adr >= 55 ? 'rating-ok' : 'rating-bad';
}

function renderTeamStats(team, isTest) {
  const section = el('div', 'scoreboard-team');
  const head = el('h3', team.won ? 'won' : '');
  const title = el('span', 'scoreboard-title');
  title.append(teamBadge(team.name), el('span', '', team.name));
  head.append(title, el('span', 'scoreboard-score', String(team.score)));

  const table = el('table', 'stats player-rows');
  const headRow = el('tr');
  for (const [label, numeric] of [['Navn', false], ['K', true], ['A', true], ['D', true], ['HS', true], ['ADR', true], ['R', true]]) {
    headRow.append(el('th', numeric ? 'num' : '', label));
  }
  const thead = el('thead');
  thead.append(headRow);
  const tbody = el('tbody');
  for (const player of team.players) {
    const row = el('tr');
    const nameCell = el('td');
    // Test players don't get profile pages.
    const link = el(isTest ? 'span' : 'a', 'stat-player-link');
    link.append(playerAvatar(player), el('span', 'stat-player-name', player.name));
    if (!isTest) link.href = `/players/${player.steamId}`;
    nameCell.append(link);
    row.append(
      nameCell,
      el('td', 'num', String(player.kills)),
      el('td', 'num', String(player.assists)),
      el('td', 'num', String(player.deaths)),
      el('td', 'num', `${player.headshotPercent}%`),
      el('td', `num ${adrClass(player.adr)}`, String(player.adr)),
      el('td', `num ${ratingClass(player.rating)}`, player.rating.toFixed(2)),
    );
    tbody.append(row);
  }
  table.append(thead, tbody);

  const wrap = el('div', 'table-wrap');
  wrap.append(table);
  section.append(head, wrap);
  return section;
}

function renderScoreboards(data) {
  document.getElementById('scoreboards').replaceChildren(...data.scoreboards.map((map) => {
    const card = el('section', 'card');
    card.append(el('h2', '', map.name));
    const teams = el('div', 'scoreboard');
    teams.append(renderTeamStats(map.teams[0], data.isTest), renderTeamStats(map.teams[1], data.isTest));
    card.append(teams);
    return card;
  }));
}

function renderMaps(data) {
  const canChoose = data.yourTurn && data.current.action !== 'side';
  mapsEl.replaceChildren(...data.maps.map((map) => {
    const tile = el(canChoose && map.state === 'open' ? 'button' : 'div', `map map-${map.state}`);
    tile.dataset.map = map.map;
    // Shows public/maps/<map>.jpg when that screenshot exists, otherwise a plain tile.
    tile.style.backgroundImage = `url(/maps/${map.map}.jpg)`;
    tile.append(el('span', 'map-name', map.name));
    if (map.state !== 'open') {
      tile.append(el('span', 'map-note', map.by ? `${STATE_TEXT[map.state]} av ${map.by}` : STATE_TEXT[map.state]));
    } else if (canChoose) {
      tile.append(el('span', 'map-note', data.current.action === 'ban' ? 'Fjern' : 'Velg'));
      tile.type = 'button';
      tile.addEventListener('click', () => act(map.map));
    }
    return tile;
  }));
}

function renderSides(data) {
  const choosing = data.yourTurn && data.current.action === 'side';
  sidesEl.hidden = !choosing;
  if (!choosing) return;
  const ct = el('button', 'button side-ct', 'Start som CT');
  const t = el('button', 'button side-t', 'Start som T');
  ct.type = 'button';
  t.type = 'button';
  ct.addEventListener('click', () => act('ct'));
  t.addEventListener('click', () => act('t'));
  sidesEl.replaceChildren(ct, t);
}

function connectBox(command) {
  const box = el('div', 'inline');
  const input = el('input');
  input.readOnly = true;
  input.value = command;
  input.setAttribute('aria-label', 'Tilkoblingskommando');
  const copy = el('button', 'button secondary', 'Kopier');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    input.select();
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      // Browsers block the clipboard API on plain http, so fall back to the older way.
      document.execCommand('copy');
    }
    copy.textContent = 'Kopiert';
    setTimeout(() => { copy.textContent = 'Kopier'; }, 1500);
  });
  box.append(input, copy);
  return box;
}

const MAP_STATUS_TEXT = {
  finished: 'Ferdig',
  live: 'Spilles nå',
  stopped: 'Avbrutt',
  next: 'Neste',
  waiting: 'Venter',
  unused: 'Til overs',
};

// Shows the side until the map has a score, and then the score.
function scoreBox(map, team) {
  const score = team === 1 ? map.team1Score : map.team2Score;
  if (map.status === 'unused') return el('span', 'map-box empty');
  if (score !== null) {
    let className = 'map-box score';
    if (map.winner) className += map.winner === `team${team}` ? ' won' : ' lost';
    return el('span', className, String(score));
  }
  if (!map.team1Side) return el('span', 'map-box knife', 'Kniv');
  const side = team === 1 ? map.team1Side : (map.team1Side === 'ct' ? 't' : 'ct');
  return el('span', `map-box side-${side}-box`, side.toUpperCase());
}

function renderSummary(data) {
  const summaryEl = document.getElementById('summary');
  summaryEl.hidden = !data.summary;
  mapsEl.hidden = Boolean(data.summary);
  if (!data.summary) return;
  const s = data.summary;

  const head = el('div', 'summary-head');
  const middle = el('div', 'summary-middle');
  middle.append(
    el('span', 'muted', `${s.played} / ${s.total} ferdigspilt`),
    el('strong', 'summary-score', `${s.seriesTeam1} - ${s.seriesTeam2}`),
    el('span', 'muted', `${s.roundsTeam1} - ${s.roundsTeam2}`),
  );
  head.append(teamBadge(s.team1), middle, teamBadge(s.team2));

  const rows = s.maps.map((map) => {
    const row = el('div', `summary-map summary-map-${map.status}`);
    row.style.backgroundImage = `url(/maps/${map.map}.jpg)`;
    const label = el('div', 'summary-map-label');
    label.append(el('span', 'summary-map-status', MAP_STATUS_TEXT[map.status]), el('strong', '', map.name));
    row.append(scoreBox(map, 1), label, scoreBox(map, 2));
    return row;
  });
  summaryEl.replaceChildren(head, ...rows);
}

function renderResult(data) {
  resultEl.hidden = !data.summary || (!data.connect && data.status !== 'sending' && !data.sendError);
  if (resultEl.hidden) return;

  const children = [];

  if (data.connect) {
    const link = el('a', 'button connect', 'Koble til serveren');
    link.href = data.connect.url;
    children.push(link);
    children.push(el('p', 'muted', 'Eller lim inn dette i konsollen:'));
    children.push(connectBox(data.connect.command));
    children.push(el('p', 'muted', 'Skriv .ready i chatten når kartet er lastet, på hvert kart.'));
    if (data.watch) {
      children.push(el('h2', 'watch-title', 'Se kampen'));
      if (data.botsOnly) children.push(el('p', 'muted', 'Dette er en kamp bare med bots. Den starter av seg selv.'));
      children.push(el('p', 'muted', 'Bare for admins. GOTV viser kampen med 90 sekunders forsinkelse. Ikke del passordet med spillerne.'));
      // Steam refuses connect links to GOTV ports, so this goes through the console.
      children.push(el('p', 'muted', 'Kopier kommandoen og lim den inn i konsollen i CS2.'));
      children.push(connectBox(data.watch.command));
    }
  } else if (data.status === 'sending') {
    children.push(el('p', 'muted', 'Sender kampen til serveren. Hvis serveren starter opp, kan dette ta noen minutter. Siden prøver igjen av seg selv.'));
  } else if (data.sendError) {
    children.push(el('p', 'flash', `Kampen kom ikke frem til serveren: ${data.sendError} Be en admin sende den på nytt.`));
  }
  resultEl.replaceChildren(...children);
}

const LOG_ICONS = { ban: '✕', pick: '✓', decider: '★' };
const LOG_LABELS = { ban: 'Fjernet', pick: 'Valgt', decider: 'Avgjørende kart' };

function renderLog(data) {
  logEl.replaceChildren(...data.log.map((entry, i) => {
    const row = el('li', `log-row log-${entry.type}`);
    row.append(el('span', 'log-number', `#${i + 1}`));

    const icon = el('span', 'log-icon', LOG_ICONS[entry.type]);
    icon.title = LOG_LABELS[entry.type];
    icon.setAttribute('aria-label', LOG_LABELS[entry.type]);
    row.append(icon);

    const map = el('span', 'log-map');
    map.append(el('strong', '', entry.name));
    if (entry.note) map.append(el('small', 'muted', entry.note));
    row.append(map);

    const by = el('span', 'log-team');
    if (entry.teamName) by.append(el('span', 'log-team-name', entry.teamName), teamBadge(entry.teamName));
    row.append(by);
    return row;
  }));
  if (data.log.length === 0) logEl.replaceChildren(el('li', 'muted', 'Ingen valg ennå.'));
}

function render(data) {
  const snapshot = JSON.stringify(data);
  if (snapshot === lastRendered) return;
  lastRendered = snapshot;
  renderTurn(data);
  renderMaps(data);
  renderSides(data);
  renderSummary(data);
  renderResult(data);
  renderScoreboards(data);
  renderLog(data);
}

async function refresh() {
  try {
    const response = await fetch(`/api/matches/${matchId}`);
    if (response.ok) render(await response.json());
  } catch {
    // Keep showing the last state, the next refresh tries again.
  }
}

refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 2000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
