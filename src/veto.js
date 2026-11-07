// The map vote rules. Pure functions, so the whole flow can be tested without a server.

export const MAP_POOLS = {
  wingman: ['de_inferno', 'de_nuke', 'de_overpass', 'de_vertigo', 'de_poseidon', 'de_debris', 'de_eldorado'],
  '5v5': ['de_ancient', 'de_anubis', 'de_cache', 'de_dust2', 'de_inferno', 'de_mirage', 'de_nuke'],
};

export const MAP_NAMES = {
  de_ancient: 'Ancient',
  de_anubis: 'Anubis',
  de_cache: 'Cache',
  de_debris: 'Debris',
  de_dust2: 'Dust II',
  de_eldorado: 'El Dorado',
  de_inferno: 'Inferno',
  de_mirage: 'Mirage',
  de_nuke: 'Nuke',
  de_overpass: 'Overpass',
  de_poseidon: 'Poseidon',
  de_vertigo: 'Vertigo',
};

const other = (team) => (team === 1 ? 2 : 1);

// Every step of the vote in order. Teams alternate bans and picks, and after a
// pick the other team chooses its side, so that team also makes the next pick.
export function buildSteps(format, firstTeam, mapCount) {
  const actions = format === 'bo3'
    ? [...Array(mapCount - 5).fill('ban'), 'pick', 'pick', 'ban', 'ban']
    : Array(mapCount - 1).fill('ban');

  const steps = [];
  actions.forEach((action, i) => {
    const team = i % 2 === 0 ? firstTeam : other(firstTeam);
    steps.push({ team, action });
    if (action === 'pick') steps.push({ team: other(team), action: 'side' });
  });

  // A BO1 ends on one map, and the team that didn't make the last ban picks its side.
  if (format === 'bo1') steps.push({ team: other(steps.at(-1).team), action: 'side' });
  return steps;
}

export function minimumMaps(format) {
  return format === 'bo3' ? 5 : 2;
}

// Works out the current state by replaying every action taken so far.
export function computeState({ format, firstTeam, pool, actions }) {
  const steps = buildSteps(format, firstTeam, pool.length);
  const remaining = [...pool];
  const banned = [];
  const picks = [];
  const history = [];

  actions.forEach((entry, i) => {
    const step = steps[i];
    if (step.action === 'ban') {
      remaining.splice(remaining.indexOf(entry.value), 1);
      banned.push({ map: entry.value, team: step.team });
      history.push({ action: 'ban', team: step.team, map: entry.value });
    } else if (step.action === 'pick') {
      remaining.splice(remaining.indexOf(entry.value), 1);
      picks.push({ map: entry.value, team: step.team, sideTeam: null, side: null });
      history.push({ action: 'pick', team: step.team, map: entry.value });
    } else {
      if (format === 'bo1') {
        picks.push({ map: remaining[0], team: null, sideTeam: step.team, side: entry.value });
      } else {
        Object.assign(picks.at(-1), { sideTeam: step.team, side: entry.value });
      }
      history.push({ action: 'side', team: step.team, map: picks.at(-1).map, side: entry.value });
    }
  });

  const next = steps[actions.length];
  const done = !next;
  let current = null;
  if (next) {
    current = { team: next.team, action: next.action };
    if (next.action === 'side') current.map = format === 'bo1' ? remaining[0] : picks.at(-1).map;
  }

  return { current, done, remaining, banned, picks, history, decider: format === 'bo3' && done ? remaining[0] : null };
}

// Checks one action against the current state. Returns an error message or null.
export function validateAction(state, team, value) {
  if (state.done) return 'Kartvalget er allerede ferdig.';
  if (state.current.team !== team) return 'Det er ikke lagets tur.';
  if (state.current.action === 'side') {
    return value === 'ct' || value === 't' ? null : 'Ugyldig side.';
  }
  return state.remaining.includes(value) ? null : 'Det kartet er ikke tilgjengelig.';
}

// The final maps in play order, using the side names MatchZy expects.
export function finalMaps(state) {
  const maps = state.picks.map((p) => ({ map: p.map, side: `team${p.sideTeam}_${p.side}` }));
  if (state.decider) maps.push({ map: state.decider, side: 'knife' });
  return maps;
}
