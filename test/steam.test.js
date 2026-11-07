import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchSteamProfile, verifySteamLogin } from '../src/steam.js';

const returnTo = 'http://site/auth/steam/callback?state=abc';
const steamId = '76561198000000000';

function goodQuery() {
  return new URLSearchParams({
    'openid.mode': 'id_res',
    'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
    'openid.return_to': returnTo,
    'openid.claimed_id': `https://steamcommunity.com/openid/id/${steamId}`,
    'openid.sig': 'x',
  });
}

const steamSays = (text) => async () => ({ text: async () => text });

test('accepts a login Steam confirms', async () => {
  assert.equal(await verifySteamLogin(goodQuery(), returnTo, steamSays('ns:x\nis_valid:true\n')), steamId);
});

test('rejects a login Steam does not confirm', async () => {
  assert.equal(await verifySteamLogin(goodQuery(), returnTo, steamSays('is_valid:false\n')), null);
});

test('rejects a forged endpoint, return address or SteamID without asking Steam', async () => {
  const neverCalled = async () => assert.fail('should not contact Steam');
  for (const [key, value] of [
    ['openid.op_endpoint', 'https://evil.example/openid/login'],
    ['openid.return_to', 'http://evil.example/'],
    ['openid.claimed_id', 'https://evil.example/openid/id/76561198000000000'],
    ['openid.mode', 'cancel'],
  ]) {
    const query = goodQuery();
    query.set(key, value);
    assert.equal(await verifySteamLogin(query, returnTo, neverCalled), null, key);
  }
});

test('reads name and avatar from the public profile', async () => {
  const xml = '<profile><steamID><![CDATA[Shadow]]></steamID><avatarMedium><![CDATA[https://a/b.jpg]]></avatarMedium></profile>';
  assert.deepEqual(await fetchSteamProfile(steamId, steamSays(xml)), { name: 'Shadow', avatar: 'https://a/b.jpg' });
});

test('login still works when the profile cannot be read', async () => {
  const failing = async () => { throw new Error('offline'); };
  assert.deepEqual(await fetchSteamProfile(steamId, failing), { name: null, avatar: null });
});
