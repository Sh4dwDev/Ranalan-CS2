import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dataDir = resolve(process.env.DATA_DIR || 'data');
mkdirSync(dataDir, { recursive: true });

function loadSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = join(dataDir, 'session-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomBytes(32).toString('hex');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function loadServers() {
  const file = resolve(process.env.SERVERS_FILE || 'servers.json');
  if (!existsSync(file)) return [];
  const servers = JSON.parse(readFileSync(file, 'utf8'));
  for (const s of servers) {
    if (!s.id || !s.name || !s.host || !s.port) {
      throw new Error(`servers.json: each server needs id, name, host and port (${JSON.stringify(s.id)})`);
    }
    s.mode = s.mode === '5v5' ? '5v5' : 'wingman';
    s.playersPerTeam = s.playersPerTeam || (s.mode === 'wingman' ? 2 : 5);
  }
  return servers;
}

const port = Number(process.env.PORT || 3000);

// Accepts a panel address typed without http://, as most tools do.
function panelAddress() {
  const address = (process.env.PANEL_URL || '').trim().replace(/\/$/, '');
  if (!address) return '';
  return /^https?:\/\//i.test(address) ? address : `http://${address}`;
}

export const config = {
  port,
  host: process.env.HOST || '0.0.0.0',
  baseUrl: (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  dataDir,
  sessionSecret: loadSessionSecret(),
  adminSteamIds: (process.env.ADMIN_STEAM_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  devLogin: process.env.DEV_LOGIN === '1',
  eventsKey: process.env.EVENTS_KEY || '',
  panelUrl: panelAddress(),
  panelKey: process.env.PANEL_API_KEY || '',
  panelIdleMs: Number(process.env.PANEL_IDLE_MS || 5 * 60 * 1000),
  panelCheckMs: Number(process.env.PANEL_CHECK_MS || 60 * 1000),
  servers: loadServers(),
};

export function findServer(id) {
  return config.servers.find((s) => s.id === id);
}
