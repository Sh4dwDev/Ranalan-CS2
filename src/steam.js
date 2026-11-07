const OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';
const CLAIMED_ID = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

export function steamLoginUrl(returnTo, realm) {
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': realm,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  return `${OPENID_ENDPOINT}?${params}`;
}

// Confirms the login with Steam directly. Returns the SteamID, or null if anything is off.
export async function verifySteamLogin(query, expectedReturnTo, fetchFn = fetch) {
  if (query.get('openid.mode') !== 'id_res') return null;
  if (query.get('openid.op_endpoint') !== OPENID_ENDPOINT) return null;
  if (query.get('openid.return_to') !== expectedReturnTo) return null;

  const match = CLAIMED_ID.exec(query.get('openid.claimed_id') || '');
  if (!match) return null;

  const body = new URLSearchParams(query);
  body.set('openid.mode', 'check_authentication');
  const response = await fetchFn(OPENID_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await response.text();
  return /^is_valid\s*:\s*true\s*$/m.test(text) ? match[1] : null;
}

function xmlValue(xml, tag) {
  const match = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`).exec(xml);
  return match ? match[1].trim() : null;
}

// Reads the public profile, which needs no API key. Login still works if this fails.
export async function fetchSteamProfile(steamId, fetchFn = fetch) {
  try {
    const response = await fetchFn(`https://steamcommunity.com/profiles/${steamId}/?xml=1`, {
      signal: AbortSignal.timeout(5000),
    });
    const xml = await response.text();
    const avatar = xmlValue(xml, 'avatarMedium');
    return {
      name: xmlValue(xml, 'steamID'),
      avatar: avatar && avatar.startsWith('https://') ? avatar : null,
    };
  } catch {
    return { name: null, avatar: null };
  }
}
