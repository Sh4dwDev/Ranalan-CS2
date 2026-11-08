// Server-rendered pages. Everything from users goes through esc(), including Steam names.

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export const STATUS_TEXT = {
  veto: 'Kartvalg pågår',
  sending: 'Sendes til serveren',
  sent: 'Klar på serveren',
  send_failed: 'Kunne ikke sendes',
  test_ready: 'Testkamp klar',
  finished: 'Ferdig',
};

const FORMAT_TEXT = { bo1: 'Best av 1', bo3: 'Best av 3' };

export function avatar(user, size = '') {
  const initial = esc((user.name || '?').slice(0, 1).toUpperCase());
  return user.avatar
    ? `<img class="avatar ${size}" src="${esc(user.avatar)}" alt="">`
    : `<span class="avatar ${size}" aria-hidden="true">${initial}</span>`;
}

export function layout({ title, user, body, flash, scripts = '' }) {
  const nav = user
    ? `<a href="/stats">Statistikk</a>
       <a href="/teams">Lag</a>
       ${user.is_admin ? '<a href="/admin">Admin</a>' : ''}
       <span class="nav-user">${avatar(user, 'small')}<span>${esc(user.name)}</span></span>
       <form method="post" action="/auth/logout"><button class="link">Logg ut</button></form>`
    : '<a href="/stats">Statistikk</a><a class="button small" href="/auth/steam">Logg inn med Steam</a>';

  return `<!doctype html>
<html lang="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Ranalan</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="topbar">
  <a class="brand" href="/">RANALAN</a>
  <nav>${nav}</nav>
</header>
<main>
${flash ? `<p class="flash">${esc(flash)}</p>` : ''}
${body}
</main>
${scripts}
</body>
</html>`;
}

function matchRow(m) {
  return `<a class="row" href="/matches/${m.id}">
    <span class="row-main">${esc(m.team1_name)} <span class="versus-small">VS</span> ${esc(m.team2_name)}</span>
    <span class="muted">${esc(FORMAT_TEXT[m.format])}</span>
    <span class="status status-${esc(m.status)}">${esc(STATUS_TEXT[m.status])}</span>
  </a>`;
}

export function homePage({ user, team, matches, flash }) {
  const hero = `<section class="hero">
    <h1>Kartvalg uten kaos.</h1>
    <p>Logg inn med Steam, bli med på laget ditt, og velg kart med noen få klikk.</p>
    <a class="button" href="/auth/steam">Logg inn med Steam</a>
  </section>`;

  const teamCard = !user ? '' : team
    ? `<section class="card"><h2>Laget ditt</h2>
        <a class="row" href="/teams/${team.id}"><span class="row-main">${esc(team.name)}</span><span class="muted">Åpne</span></a>
      </section>`
    : `<section class="card"><h2>Du er ikke på et lag</h2>
        <p class="muted">Lag et nytt lag her, eller bruk invitasjonslenken fra kapteinen din.</p>
        <form method="post" action="/teams" class="inline">
          <input name="name" maxlength="32" required placeholder="Lagnavn" aria-label="Lagnavn">
          <button class="button">Opprett lag</button>
        </form>
      </section>`;

  return layout({
    title: 'Hjem',
    user,
    flash,
    body: `${user ? '' : hero}${teamCard}
      <section class="card"><h2>Kamper</h2>
        ${matches.length ? matches.map(matchRow).join('') : '<p class="muted">Ingen kamper ennå.</p>'}
      </section>`,
  });
}

export function teamsPage({ user, teams, flash }) {
  return layout({
    title: 'Lag',
    user,
    flash,
    body: `<section class="card"><h1>Lag</h1>
      ${teams.length
        ? teams.map((t) => `<a class="row" href="/teams/${t.id}"><span class="row-main">${esc(t.name)}</span></a>`).join('')
        : '<p class="muted">Ingen lag ennå.</p>'}
    </section>`,
  });
}

export function teamPage({ user, team, members, inviteUrl, locked, flash }) {
  const isCaptain = user?.steam_id === team.captain_id;
  const isMember = members.some((m) => m.steam_id === user?.steam_id);

  const rows = members.map((m) => {
    const isThisCaptain = m.steam_id === team.captain_id;
    const controls = isCaptain && !isThisCaptain && !locked
      ? `<form method="post" action="/teams/${team.id}/captain"><input type="hidden" name="steam_id" value="${esc(m.steam_id)}"><button class="link">Gjør til kaptein</button></form>
         <form method="post" action="/teams/${team.id}/remove"><input type="hidden" name="steam_id" value="${esc(m.steam_id)}"><button class="link danger">Fjern</button></form>`
      : '';
    return `<div class="row">
      ${avatar(m, 'small')}
      <span class="row-main">${esc(m.name)}</span>
      ${isThisCaptain ? '<span class="badge">Kaptein</span>' : ''}
      ${controls}
    </div>`;
  }).join('');

  const invite = isCaptain ? `<section class="card"><h2>Inviter spillere</h2>
      <p class="muted">Del denne lenken med laget ditt. De logger inn med Steam og er med.</p>
      <div class="inline">
        <input id="invite" readonly value="${esc(inviteUrl)}" aria-label="Invitasjonslenke">
        <button class="button" type="button" data-copy="invite">Kopier</button>
      </div>
      <form method="post" action="/teams/${team.id}/invite"><button class="link">Lag ny lenke</button></form>
    </section>` : '';

  const leave = isMember && !isCaptain && !locked
    ? `<form method="post" action="/teams/${team.id}/leave"><button class="link danger">Forlat laget</button></form>`
    : '';

  return layout({
    title: team.name,
    user,
    flash,
    body: `<section class="card"><h1>${esc(team.name)}</h1>
        ${locked ? '<p class="muted">Laget er låst så lenge det har en kamp som ikke er ferdig.</p>' : ''}
        ${rows}
        ${leave}
      </section>${invite}`,
    scripts: '<script src="/copy.js"></script>',
  });
}

export function joinPage({ user, team, memberCount, currentTeam, flash }) {
  let action;
  if (!user) {
    action = `<a class="button" href="/auth/steam?next=${encodeURIComponent(`/join/${team.invite_token}`)}">Logg inn med Steam for å bli med</a>`;
  } else if (currentTeam?.id === team.id) {
    action = `<a class="button" href="/teams/${team.id}">Du er allerede på laget</a>`;
  } else if (currentTeam) {
    action = `<p class="muted">Du er på ${esc(currentTeam.name)}. Forlat det laget først for å bli med her.</p>`;
  } else {
    action = `<form method="post"><button class="button">Bli med på ${esc(team.name)}</button></form>`;
  }

  return layout({
    title: `Bli med på ${team.name}`,
    user,
    flash,
    body: `<section class="card center"><h1>${esc(team.name)}</h1>
      <p class="muted">${memberCount} ${memberCount === 1 ? 'spiller' : 'spillere'} på laget</p>
      ${action}
    </section>`,
  });
}

const DELETE_MATCH_TEXT = 'Slette denne kampen? Kartvalget slettes også, og lagene blir låst opp. Dette kan ikke angres. '
  + 'Hvis kampen allerede er sendt til serveren, blir den liggende der til noen avslutter den i spillet.';

const SERVER_STATE_TEXT = {
  running: 'Kjører',
  starting: 'Starter',
  stopping: 'Stopper',
  offline: 'Av',
};

export function adminPage({ user, teams, servers, serverStates = [], matches, users, flash }) {
  const serverRows = serverStates.map((s) => `<div class="row">
      <span class="row-main">${esc(s.name)}</span>
      ${s.canPower
        ? `<span class="status status-server-${esc(s.state || 'unknown')}">${esc(SERVER_STATE_TEXT[s.state] || 'Ukjent')}</span>
           <form method="post" action="/admin/servers/${esc(s.id)}/start"><button class="link">Start</button></form>
           <form method="post" action="/admin/servers/${esc(s.id)}/stop"><button class="link danger">Stopp</button></form>`
        : '<span class="muted">Ikke koblet til panelet</span>'}
    </div>`).join('');

  const teamOptions = (selected) => teams.map((t, i) => (
    `<option value="${t.id}"${i === selected ? ' selected' : ''}>${esc(t.name)}</option>`
  )).join('');
  const choice = (name, value, title, note, checked) => `<label class="choice">
      <input type="radio" name="${name}" value="${value}"${checked ? ' checked' : ''}>
      <span><strong>${title}</strong>${note ? `<small>${note}</small>` : ''}</span>
    </label>`;
  const serverOptions = servers.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');

  const canCreate = teams.length >= 2 && servers.length > 0;
  const hint = servers.length === 0
    ? 'Ingen servere er satt opp ennå. Legg dem til i servers.json.'
    : 'Du trenger minst to lag for å lage en kamp.';

  const serverNames = new Map(servers.map((s) => [s.id, s.name]));
  const open = (m) => m.status !== 'finished';
  // Unfinished matches first, newest first within each group.
  const sortedMatches = [...matches].sort((a, b) => (open(b) - open(a)) || (b.id - a.id));
  const matchRows = sortedMatches.map((m) => {
    const groups = [open(m) ? 'open' : 'finished', m.is_test ? 'test' : 'real'].join(' ');
    return `<div class="row admin-row" data-groups="${groups}"
        data-search="${esc(`${m.team1_name} ${m.team2_name} ${serverNames.get(m.server_id) || ''} #${m.id}`.toLowerCase())}">
      <span class="row-id">#${m.id}</span>
      <a class="row-main" href="/matches/${m.id}">${esc(m.team1_name)} <span class="versus-small">VS</span> ${esc(m.team2_name)}</a>
      <span class="row-meta">${esc(FORMAT_TEXT[m.format])} · ${esc(serverNames.get(m.server_id) || m.server_id)} · ${esc(shortTime(m.created_at))}</span>
      ${m.is_test ? '<span class="badge">Test</span>' : ''}
      <span class="status status-${esc(m.status)}">${esc(STATUS_TEXT[m.status])}</span>
      <form method="post" action="/matches/${m.id}/delete" data-confirm="${esc(DELETE_MATCH_TEXT)}">
        <button class="link danger">Slett</button>
      </form>
    </div>`;
  }).join('');

  const teamRows = teams.map((t) => {
    const groups = [t.locked ? 'locked' : 'free', t.memberCount === 0 ? 'empty' : ''].join(' ');
    return `<div class="row admin-row" data-groups="${groups}"
        data-search="${esc(`${t.name} ${t.captainName}`.toLowerCase())}">
      <a class="row-main" href="/teams/${t.id}">${esc(t.name)}</a>
      <span class="row-meta">${t.memberCount} ${t.memberCount === 1 ? 'spiller' : 'spillere'}${t.captainName ? ` · Kaptein: ${esc(t.captainName)}` : ''}</span>
      ${t.locked
        ? '<span class="status status-sent">I kamp</span>'
        : `<form method="post" action="/admin/teams/${t.id}/delete"
            data-confirm="${esc(`Slette ${t.name}? Spillerne mister laget, og lagets ferdige kamper slettes også. Dette kan ikke angres.`)}">
            <button class="link danger">Slett</button>
          </form>`}
    </div>`;
  }).join('');

  const userRows = users.map((u) => {
    const groups = [u.is_admin ? 'admin' : '', u.teamName ? 'team' : 'noteam'].join(' ');
    return `<div class="row admin-row" data-groups="${groups}"
        data-search="${esc(`${u.name} ${u.steam_id} ${u.teamName}`.toLowerCase())}">
      ${avatar(u, 'small')}
      <span class="row-main">${esc(u.name)}<small class="row-sub">${esc(u.steam_id)}</small></span>
      <span class="row-meta">${u.teamName ? esc(u.teamName) : 'Uten lag'}</span>
      ${u.is_admin ? '<span class="badge">Admin</span>' : ''}
      ${u.steam_id === user.steam_id ? '<span class="muted">Deg</span>' : `<form method="post" action="/admin/users">
        <input type="hidden" name="steam_id" value="${esc(u.steam_id)}">
        <input type="hidden" name="admin" value="${u.is_admin ? '0' : '1'}">
        <button class="link ${u.is_admin ? 'danger' : ''}">${u.is_admin ? 'Fjern admin' : 'Gjør til admin'}</button>
      </form>`}
    </div>`;
  }).join('');

  const openCount = matches.filter(open).length;
  const runningCount = serverStates.filter((s) => s.state === 'running').length;
  const stat = (tab, value, label) => `<a class="stat-tile" href="#${tab}" data-tab-link="${tab}">
      <strong>${value}</strong><span>${label}</span></a>`;
  const tabs = [
    ['kamper', 'Kamper', matches.length],
    ['ny-kamp', 'Ny kamp', null],
    ['lag', 'Lag', teams.length],
    ['brukere', 'Brukere', users.length],
    ['servere', 'Servere', serverStates.length],
    ['testkamp', 'Testkamp', null],
  ];

  return layout({
    title: 'Admin',
    user,
    flash,
    body: `<div class="admin">
    <div class="admin-head">
      <h1>Admin</h1>
      <a class="button small" href="#ny-kamp" data-tab-link="ny-kamp">Ny kamp</a>
    </div>
    <div class="stat-tiles">
      ${stat('kamper', openCount, 'Kamper pågår')}
      ${stat('lag', teams.length, 'Lag')}
      ${stat('brukere', users.length, 'Brukere')}
      ${serverStates.length ? stat('servere', `${runningCount}/${serverStates.length}`, 'Servere på') : ''}
    </div>
    <nav class="admin-tabs" aria-label="Admin">
      ${tabs.map(([id, label, count]) => `<a href="#${id}" data-tab-link="${id}">${label}${count === null ? '' : ` <span class="tab-count">${count}</span>`}</a>`).join('')}
    </nav>
    ${listSection('kamper', 'Kamper', 'Søk etter lag, server eller kampnummer', [
      ['open', 'Pågår'], ['finished', 'Ferdige'], ['test', 'Test'], ['all', 'Alle'],
    ], matchRows, 'Ingen kamper ennå.')}
    <section class="card admin-panel" id="ny-kamp"><h2>Opprett kamp</h2>
      ${canCreate ? `<form method="post" action="/matches" class="create-match">
        <div class="pick-teams">
          <label>Lag 1 <select name="team1" required>${teamOptions(0)}</select></label>
          <span class="versus-mark" aria-hidden="true">VS</span>
          <label>Lag 2 <select name="team2" required>${teamOptions(1)}</select></label>
        </div>
        <fieldset><legend>Format</legend><div class="choices">
          ${choice('format', 'bo1', 'Best av 1', 'Ett kart', false)}
          ${choice('format', 'bo3', 'Best av 3', 'Tre kart', true)}
        </div></fieldset>
        <fieldset><legend>Hvem starter kartvalget?</legend><div class="choices">
          ${choice('first', 'random', 'Tilfeldig', '', true)}
          ${choice('first', '1', 'Lag 1', '', false)}
          ${choice('first', '2', 'Lag 2', '', false)}
        </div></fieldset>
        <label>Server <select name="server" required>${serverOptions}</select></label>
        <button class="button big">Opprett kamp</button>
        <p class="muted">Du får en lenke du kan dele med lagene med en gang.</p>
      </form>` : `<p class="muted">${esc(hint)}</p>`}
    </section>
    ${listSection('lag', 'Lag', 'Søk etter lag eller kaptein', [
      ['all', 'Alle'], ['locked', 'I kamp'], ['empty', 'Uten spillere'],
    ], teamRows, 'Ingen lag ennå.')}
    ${listSection('brukere', 'Brukere', 'Søk etter navn, Steam ID eller lag', [
      ['all', 'Alle'], ['admin', 'Admins'], ['noteam', 'Uten lag'],
    ], userRows, 'Ingen brukere ennå.')}
    <section class="card admin-panel" id="servere"><h2>Servere</h2>
      <p class="muted">Serverne starter når en kamp lages og stopper noen minutter etter at de ikke trengs. Start en server her for å bli med uten kamp. Den holdes på i minst en time.</p>
      ${serverRows || '<p class="muted">Ingen servere er satt opp ennå.</p>'}
    </section>
    <section class="card admin-panel" id="testkamp"><h2>Testkamp</h2>
      <p class="muted">Spill en ekte kamp mot bots på serveren. Du velger kart for begge lag. Testkamper vises ikke på forsiden og teller ikke i statistikken.</p>
      ${servers.length ? `<form method="post" action="/matches/test" class="create-match">
        <label>Spill med <select name="team">
          <option value="">Bare meg</option>
          <option value="bots">Bare bots (se på med GOTV)</option>
          ${teams.filter((t) => !t.locked).map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}
        </select></label>
        <fieldset><legend>Format</legend><div class="choices">
          ${choice('format', 'bo1', 'Best av 1', 'Ett kart', true)}
          ${choice('format', 'bo3', 'Best av 3', 'Tre kart', false)}
        </div></fieldset>
        <label>Server <select name="server" required>${serverOptions}</select></label>
        <button class="button secondary big">Lag testkamp</button>
      </form>` : `<p class="muted">${esc(hint)}</p>`}
    </section>
    </div>`,
    scripts: '<script src="/copy.js"></script><script src="/admin.js"></script>',
  });
}

// A searchable list on the Admin page. admin.js does the searching and filtering in the
// browser; without it, every row is shown.
function listSection(id, title, placeholder, filters, rows, empty) {
  return `<section class="card admin-panel" id="${id}" data-list>
      <h2>${title}</h2>
      ${rows ? `<div class="list-tools">
        <input type="search" data-search-input placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}">
        <div class="filter-chips" role="group" aria-label="Filter">
          ${filters.map(([value, label], i) => `<button type="button" class="chip" data-filter="${value}" aria-pressed="${i === 0}">${label}</button>`).join('')}
        </div>
      </div>
      <p class="list-count muted" data-list-count></p>
      <div class="admin-list">${rows}</div>
      <p class="muted" data-no-hits hidden>Ingen treff.</p>
      <button type="button" class="button secondary small" data-show-more hidden>Vis flere</button>`
    : `<p class="muted">${empty}</p>`}
    </section>`;
}

const TIME_FORMAT = new Intl.DateTimeFormat('nb-NO', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Oslo',
});

function shortTime(ms) {
  return ms ? TIME_FORMAT.format(new Date(ms)) : '';
}

function teamPanel(number, team, members) {
  const players = members.map((m) => `<li class="player">
      ${avatar(m, 'small')}
      <span class="player-name">${esc(m.name)}</span>
      ${m.steam_id === team.captain_id ? '<span class="badge" title="Kaptein">C</span>' : ''}
    </li>`).join('');
  return `<aside class="team-panel" id="team-panel-${number}">
      <h2><a href="/teams/${team.id}">${esc(team.name)}</a></h2>
      <ul class="players">${players}</ul>
    </aside>`;
}

export function matchPage({ user, match, team1, team2, members1, members2, matchUrl, flash }) {
  const share = user?.is_admin ? `<section class="card share">
      <h2>Del kampen</h2>
      <p class="muted">Send denne lenken til lagene. Kapteinene velger kart her.</p>
      <div class="inline">
        <input id="match-link" readonly value="${esc(matchUrl)}" aria-label="Lenke til kampen">
        <button class="button" type="button" data-copy="match-link">Kopier lenke</button>
      </div>
    </section>` : '';
  const login = user ? '' : `<p class="login-hint">Er du kaptein?
      <a href="/auth/steam?next=${encodeURIComponent(`/matches/${match.id}`)}">Logg inn med Steam</a> for å velge kart.</p>`;

  const testTools = user?.is_admin && match.is_test ? `<section class="card admin-tools"><h2>Test</h2>
      <p class="muted">Når kartvalget er ferdig, kobler dere til og skriver .ready. Bots fyller lagene, og kampen starter når alle spillerne er klare.</p>
      <div class="inline">
        <form method="post" action="/matches/${match.id}/test-start"><button class="button secondary">Start kampen nå</button></form>
        <form method="post" action="/matches/${match.id}/simulate"><button class="button secondary">Fyll inn tilfeldig resultat</button></form>
      </div>
    </section>` : '';

  const adminTools = user?.is_admin ? `${testTools}<section class="card admin-tools"><h2>Admin</h2>
      <div class="inline">
        <form method="post" action="/matches/${match.id}/send"><button class="button secondary">Send til serveren på nytt</button></form>
        <form method="post" action="/matches/${match.id}/finish"><button class="button secondary">Merk som ferdig</button></form>
        <form method="post" action="/matches/${match.id}/delete" data-confirm="${esc(DELETE_MATCH_TEXT)}"><button class="button secondary danger-text">Slett kampen</button></form>
      </div>
    </section>` : '';

  return layout({
    title: `${team1.name} mot ${team2.name}`,
    user,
    flash,
    body: `<section class="versus">
        <h1 class="versus-teams">
          <span class="versus-team">${esc(team1.name)}</span>
          <span class="versus-mark">VS</span>
          <span class="versus-team">${esc(team2.name)}</span>
        </h1>
        <p id="series-score" class="series-score" hidden></p>
        <span class="badge">${esc(FORMAT_TEXT[match.format])}</span>
        ${match.is_test ? '<span class="badge">Testkamp</span>' : ''}
      </section>
      ${share}
      ${login}
      <div id="match" data-id="${match.id}">
        <p id="turn" class="turn" role="status" aria-live="polite"></p>
        <p id="error" class="flash" hidden></p>
        <div class="match-layout">
          ${teamPanel(1, team1, members1)}
          <div class="match-center">
            <div id="sides" class="sides" hidden></div>
            <div id="maps" class="maps"></div>
            <section id="summary" class="match-summary" hidden></section>
          </div>
          ${teamPanel(2, team2, members2)}
        </div>
        <section id="result" class="card" hidden></section>
        <div id="scoreboards"></div>
        <section class="card"><h2>Valg av kart</h2><ol id="log" class="log"></ol></section>
      </div>
      ${adminTools}`,
    scripts: '<script src="/match.js"></script><script src="/copy.js"></script>',
  });
}

export function percent(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

export function perRound(total, rounds) {
  return rounds > 0 ? Math.round(total / rounds) : 0;
}

function killDeath(kills, deaths) {
  return (deaths > 0 ? kills / deaths : kills).toFixed(2);
}

// Ranalan's own rating, where 1.00 is about average: kills, survival and damage per round.
export function rating(kills, deaths, damage, rounds) {
  if (rounds <= 0) return 0;
  const killScore = (kills / rounds) / 0.7;
  const surviveScore = (1 - deaths / rounds) / 0.3;
  const damageScore = (damage / rounds) / 75;
  return Math.max(0, Math.round((0.45 * killScore + 0.2 * surviveScore + 0.35 * damageScore) * 100) / 100);
}

function ratingClass(value) {
  if (value >= 1.05) return 'good';
  return value >= 0.85 ? 'ok' : 'bad';
}

export function statsPage({ user, players, flash }) {
  const ranked = players
    .map((p) => ({ ...p, rating: rating(p.kills, p.deaths, p.damage, p.rounds_played) }))
    .sort((a, b) => b.rating - a.rating);

  const rows = ranked.map((p, i) => `<tr>
      <td class="num muted">${i + 1}</td>
      <td class="stat-player"><a href="/players/${esc(p.steam_id)}">${avatar(p, 'small')}<span>${esc(p.name)}</span></a></td>
      <td class="num">${p.maps}</td>
      <td class="num">${p.kills}</td>
      <td class="num">${p.deaths}</td>
      <td class="num">${p.assists}</td>
      <td class="num">${killDeath(p.kills, p.deaths)}</td>
      <td class="num">${percent(p.headshot_kills, p.kills)}%</td>
      <td class="num">${perRound(p.damage, p.rounds_played)}</td>
      <td class="num rating-${ratingClass(p.rating)}">${p.rating.toFixed(2)}</td>
    </tr>`).join('');

  return layout({
    title: 'Statistikk',
    user,
    flash,
    body: `<section class="card"><h1>Statistikk</h1>
      ${players.length ? `<div class="table-wrap"><table class="stats">
        <thead><tr><th class="num">#</th><th>Spiller</th><th class="num">Kart</th><th class="num">K</th><th class="num">D</th><th class="num">A</th><th class="num">K/D</th><th class="num">HS</th><th class="num">ADR</th><th class="num" title="Ranalans egen rating, der 1.00 er omtrent gjennomsnittet">R</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>` : '<p class="muted">Ingen statistikk ennå. Den kommer etter første kamp.</p>'}
    </section>`,
  });
}

export function playerPage({ user, player, maps, flash }) {
  const tile = (value, label) => `<div class="stat-tile"><strong>${value}</strong><span>${label}</span></div>`;
  const rows = maps.map((m) => `<tr>
      <td><a href="/matches/${m.match_id}">${esc(m.team1_name)} <span class="versus-small">VS</span> ${esc(m.team2_name)}</a></td>
      <td>${esc(m.mapName)}</td>
      <td class="num">${m.team1_score ?? 0} - ${m.team2_score ?? 0}</td>
      <td class="num">${m.kills}/${m.deaths}/${m.assists}</td>
      <td class="num">${percent(m.headshot_kills, m.kills)}%</td>
      <td class="num">${perRound(m.damage, m.rounds_played)}</td>
    </tr>`).join('');

  return layout({
    title: player.name,
    user,
    flash,
    body: `<section class="card">
        <div class="player-head">${avatar(player)}<h1>${esc(player.name)}</h1></div>
        <div class="stat-tiles">
          ${tile(rating(player.kills, player.deaths, player.damage, player.rounds_played).toFixed(2), 'Rating')}
          ${tile(player.maps, 'Kart')}
          ${tile(player.kills, 'Kills')}
          ${tile(killDeath(player.kills, player.deaths), 'K/D')}
          ${tile(`${percent(player.headshot_kills, player.kills)}%`, 'Headshots')}
          ${tile(perRound(player.damage, player.rounds_played), 'ADR')}
          ${tile(player.mvp, 'MVP')}
        </div>
      </section>
      <section class="card"><h2>Siste kart</h2>
        <div class="table-wrap"><table class="stats">
          <thead><tr><th>Kamp</th><th>Kart</th><th class="num">Stilling</th><th class="num">K/D/A</th><th class="num">HS</th><th class="num">ADR</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </section>`,
  });
}

export function errorPage({ user, status, message }) {
  return layout({
    title: 'Noe gikk galt',
    user,
    body: `<section class="card center"><h1>${status === 404 ? 'Fant ikke siden' : 'Noe gikk galt'}</h1>
      <p class="muted">${esc(message)}</p><a class="button" href="/">Til forsiden</a></section>`,
  });
}
