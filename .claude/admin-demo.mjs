// Starts the site on a throwaway database full of fake players, to look at the Admin page
// with many users. Not used by the real site.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'ranalan-admin-demo-'));
process.env.DEV_LOGIN = '1';
process.env.HOST = '127.0.0.1';
process.env.PORT = '3001';

const store = await import('../src/db.js');
const { config } = await import('../src/config.js');

const words = ['Nordlys', 'Fjell', 'Storm', 'Ulv', 'Bjørn', 'Is', 'Torden', 'Elg', 'Snø', 'Ravn'];
for (let i = 1; i <= 160; i++) {
  store.upsertUser(`7656119900000${String(i).padStart(4, '0')}`, { name: `Spiller ${i}`, avatar: null }, i <= 3);
}
const servers = config.servers.length ? config.servers : [{ id: 'test', mode: 'wingman' }];
const teamIds = [];
for (let t = 0; t < 40; t++) {
  const captain = `7656119900000${String(t * 3 + 1).padStart(4, '0')}`;
  const id = store.createTeam(`${words[t % 10]} ${Math.floor(t / 10) + 1}`, captain);
  store.addMember(id, `7656119900000${String(t * 3 + 2).padStart(4, '0')}`);
  teamIds.push(id);
}
for (let m = 0; m < 70; m++) {
  const id = store.createMatch({
    team1Id: teamIds[m % 40], team2Id: teamIds[(m + 7) % 40], format: m % 3 ? 'bo1' : 'bo3',
    server: servers[m % servers.length], firstTeam: 1, isTest: m % 9 === 0,
  });
  if (m < 64) store.setMatchStatus(id, 'finished');
}

await import('../src/server.js');
