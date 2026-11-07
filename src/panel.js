import { config } from './config.js';

// Talks to Pterodactyl's client API, so the panel stays in charge of the servers.

export function panelEnabled(server) {
  return Boolean(config.panelUrl && config.panelKey && server?.panelId);
}

async function panelRequest(path, options = {}) {
  const response = await fetch(`${config.panelUrl}/api/client${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.panelKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Panelet svarte ${response.status}`);
  return response;
}

// One of running, starting, stopping or offline. Null if the panel can't say.
export async function getServerState(server) {
  if (!panelEnabled(server)) return null;
  try {
    const response = await panelRequest(`/servers/${encodeURIComponent(server.panelId)}/resources`);
    return (await response.json()).attributes?.current_state ?? null;
  } catch (err) {
    console.error(`Could not read the state of ${server.id}: ${err.message}`);
    return null;
  }
}

export async function setServerPower(server, signal) {
  await panelRequest(`/servers/${encodeURIComponent(server.panelId)}/power`, {
    method: 'POST',
    body: JSON.stringify({ signal }),
  });
}
