import { strict as assert } from 'node:assert';
import test from 'node:test';
import { dayStart, nextDayStart, isQuiet, localDate, sensitiveWarnings, validateAccountName, validTimezone } from '../server/domain';
import { contentSecurityPolicy, requireSecureTransport, validateHost } from '../server/security';
import type { Bindings } from '../server/types';

test('quiet hours support crossing midnight and end is exclusive', () => {
  const japanNight = Date.parse('2026-11-20T14:30:00Z');
  const japanDay = Date.parse('2026-11-21T03:00:00Z');
  assert.equal(isQuiet(japanNight, 'Asia/Tokyo', '22:00', '07:00'), true);
  assert.equal(isQuiet(japanDay, 'Asia/Tokyo', '22:00', '07:00'), false);
  assert.equal(isQuiet(Date.parse('2026-11-20T22:00:00Z'), 'Asia/Tokyo', '22:00', '07:00'), false);
});

test('daily boundaries use the agent timezone, including DST changes', () => {
  const tokyo = Date.parse('2026-11-20T16:00:00Z');
  assert.equal(localDate(tokyo, 'Asia/Tokyo'), '2026-11-21');
  assert.equal(dayStart(tokyo, 'Asia/Tokyo'), Date.parse('2026-11-20T15:00:00Z'));
  const newYork = Date.parse('2026-11-01T15:00:00Z');
  assert.equal(dayStart(newYork, 'America/New_York'), Date.parse('2026-11-01T04:00:00Z'));
  assert.equal(nextDayStart(newYork, 'America/New_York'), Date.parse('2026-11-02T05:00:00Z'));
  assert.equal(nextDayStart(Date.parse('2026-03-08T05:00:00Z'), 'America/New_York'), Date.parse('2026-03-09T04:00:00Z'));
  assert.equal(validTimezone('Not/A_Real_Zone'), false);
});

test('reserved and malformed subdomain account names are rejected', () => {
  assert.equal(validateAccountName('Examplehost'), 'examplehost');
  assert.throws(() => validateAccountName('api'));
  assert.throws(() => validateAccountName('staging'));
  assert.throws(() => validateAccountName('-unsafe'));
});

test('privacy warning only reports detectable patterns for selected categories', () => {
  assert.deepEqual(sensitiveWarnings('住所は〒123-4567です', ['address']), ['address']);
  assert.deepEqual(sensitiveWarnings('住所は〒123-4567です', ['health']), []);
  assert.deepEqual(sensitiveWarnings('こんにちは', ['address', 'health']), []);
});



test('production fails closed if the personal beta or canonical host is misconfigured', () => {
  const env = { ENVIRONMENT: 'production', PRIVATE_BETA: 'true', OWNER_ACCOUNT: 'examplehost', PUBLIC_ORIGIN: 'https://app.a2aroom.com' } as Bindings;
  assert.doesNotThrow(() => validateHost(new Request('https://app.a2aroom.com/rooms/example'), env));
  const directory = { ...env, DIRECTORY_ORIGIN: 'https://a2aroom.com' };
  assert.doesNotThrow(() => validateHost(new Request('https://a2aroom.com/'), directory));
  assert.throws(() => validateHost(new Request('https://a2aroom.com/'), env));
  assert.throws(() => validateHost(new Request('https://a2aroom.com/'), {...directory,PUBLIC_ORIGIN:'https://staging.a2aroom.com'}));
  assert.throws(() => validateHost(new Request('https://sato.a2aroom.com/rooms/example'), env));
  assert.throws(() => validateHost(new Request('https://app.a2aroom.com/'), { ...env, PRIVATE_BETA: 'false' }));
  assert.throws(() => validateHost(new Request('https://app.a2aroom.com/'), { ...env, ENVIRONMENT: 'development' }));
});

test('production redirects insecure page requests and rejects insecure writes', () => {
  const env = { ENVIRONMENT: 'production' } as Bindings;
  const redirect = requireSecureTransport(new Request('http://app.a2aroom.com/rooms/example?view=1'), env);
  assert.equal(redirect?.status, 308);
  assert.equal(redirect?.headers.get('Location'), 'https://app.a2aroom.com/rooms/example?view=1');
  assert.equal(requireSecureTransport(new Request('http://app.a2aroom.com/api/login', { method: 'POST' }), env)?.status, 403);
  assert.equal(requireSecureTransport(new Request('https://app.a2aroom.com/'), env), null);
});

test('consent CSP allows only a safe validated callback origin', () => {
  assert.match(contentSecurityPolicy({ formOrigin: 'https://agent.example' }), /form-action 'self' https:\/\/agent\.example$/);
  assert.match(contentSecurityPolicy({ formOrigin: 'http://[::1]:49199' }), /form-action 'self' http:\/\/\[::1\]:49199$/);
  assert.throws(() => contentSecurityPolicy({ formOrigin: 'https://agent.example;script-src' }));
  assert.throws(() => contentSecurityPolicy({ formOrigin: 'https://agent.example/path' }));
  assert.throws(() => contentSecurityPolicy({ formOrigin: 'data:' }));
});

test('the directory CSP permits a connection to the account session status endpoint', () => {
  const connectSources = (policy: string) => policy.split('; ').find(directive => directive.startsWith('connect-src '));
  assert.equal(connectSources(contentSecurityPolicy()), "connect-src 'self'");
  assert.equal(connectSources(contentSecurityPolicy({ directoryHome: true })),
    "connect-src 'self' https://app.a2aroom.com/api/session/status https://app.a2aroom.com/api/rooms");
});
