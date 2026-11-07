import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

const SESSION_DAYS = 30;

function sign(value) {
  return createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
}

export function seal(value) {
  return `${value}.${sign(value)}`;
}

export function unseal(sealed) {
  if (!sealed) return null;
  const dot = sealed.lastIndexOf('.');
  if (dot < 0) return null;
  const value = sealed.slice(0, dot);
  const given = Buffer.from(sealed.slice(dot + 1));
  const expected = Buffer.from(sign(value));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return value;
}

export function parseCookies(header) {
  const cookies = {};
  for (const part of (header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) cookies[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return cookies;
}

export function cookieHeader(name, value, maxAgeSeconds) {
  const secure = config.baseUrl.startsWith('https://') ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function createSession(steamId) {
  const expires = Date.now() + SESSION_DAYS * 86400 * 1000;
  return cookieHeader('session', seal(`${steamId}:${expires}`), SESSION_DAYS * 86400);
}

export function readSession(cookies) {
  const value = unseal(cookies.session);
  if (!value) return null;
  const [steamId, expires] = value.split(':');
  return Number(expires) > Date.now() ? steamId : null;
}
