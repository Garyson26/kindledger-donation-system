/**
 * =============================================================================
 * trust proxy, end to end through the real Nginx container (SPEC-2 section 7.3)
 * =============================================================================
 *   docker compose up -d
 *   HEALTH_DIAGNOSTIC_SECRET=<the value the api container was started with> \
 *     TEST_STACK=1 npm run test:trust-proxy
 *
 * WHY THIS SUITE EXISTS SEPARATELY, AND WHY IT USES DOCKER.
 *
 * Package A's test set X-Forwarded-For directly on a request to Express with no
 * proxy in front. That proves Express READS the header. It does not prove
 * Express reads it SAFELY, because in that arrangement the attacker is the only
 * one writing it - the test passes identically whether the deployment discards
 * a client-supplied value or trusts it. The whole question is what happens to a
 * header the client sent, and you cannot ask that without the proxy that is
 * supposed to overwrite it.
 *
 * So the requests here are issued from throwaway containers on the compose
 * network, through nginx, to the api service. Two things are asserted:
 *
 *   1. A client-supplied X-Forwarded-For is DISCARDED. The address the
 *      application resolves is the address that opened the connection, not the
 *      one the client claimed.
 *   2. Distinct clients land in distinct buckets. Two containers running at the
 *      same time hold distinct bridge addresses, so this is a real pair of
 *      clients rather than one client asserting it is two.
 *
 * The second is what makes the first matter: if every client resolved to the
 * nginx container's own address, a client-supplied header would indeed be
 * discarded - and every visitor on the internet would share one rate-limit
 * bucket, so five bad logins anywhere would lock out everyone. Both properties
 * have to hold together.
 * =============================================================================
 */

'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

// Compose project name is `kindledger` (docker-compose.yml `name:`), so the
// `internal` network is created as kindledger_internal.
const NETWORK = process.env.TEST_COMPOSE_NETWORK || 'kindledger_internal';
const CURL_IMAGE = process.env.TEST_CURL_IMAGE || 'curlimages/curl:8.11.0';

// The address the caller claims. Chosen to be obviously not a bridge address:
// if it ever comes back as the resolved client IP, the spoof was believed.
const SPOOFED = '203.0.113.7';

let SECRET;

/**
 * Issue one request to nginx from a fresh container and return the parsed body.
 *
 * --network puts the container on the compose bridge, so it reaches nginx by
 * service name and, more importantly, it arrives with its OWN source address
 * rather than the host's.
 */
async function curlThroughNginx({ spoof = null, extraArgs = [] } = {}) {
  const args = [
    'run',
    '--rm',
    '--network',
    NETWORK,
    CURL_IMAGE,
    '--silent',
    '--show-error',
    '--max-time',
    '15',
    '-H',
    `x-health-secret: ${SECRET}`,
  ];
  if (spoof) args.push('-H', `X-Forwarded-For: ${spoof}`);
  args.push(...extraArgs, 'http://nginx/api/health');

  const { stdout } = await execFileAsync('docker', args, { timeout: 120000 });
  return JSON.parse(stdout);
}

function isPrivateV4(ip) {
  // Docker bridge networks allocate from RFC1918. Anything else means the
  // address did not come from where we think it did.
  return (
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

before(async () => {
  if (!process.env.TEST_STACK) {
    // Deliberately a hard failure, not a silent skip. A trust-proxy assertion
    // that quietly passes when it did not run is worse than no assertion.
    throw new Error(
      'TEST_STACK is not set. This suite requires the full compose stack: ' +
        '`docker compose up -d`, then run with TEST_STACK=1 and ' +
        'HEALTH_DIAGNOSTIC_SECRET set to the value the api container has.'
    );
  }
  SECRET = process.env.HEALTH_DIAGNOSTIC_SECRET;
  assert.ok(
    SECRET && SECRET.length >= 16,
    'HEALTH_DIAGNOSTIC_SECRET must be set (>=16 chars) and must match the api container'
  );

  // Fail on the environment rather than inside an assertion, so a missing
  // stack does not read as a trust-proxy defect.
  await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}']);
  const { stdout } = await execFileAsync('docker', [
    'network',
    'inspect',
    NETWORK,
    '--format',
    '{{.Name}}',
  ]);
  assert.match(stdout.trim(), new RegExp(`^${NETWORK}$`), 'compose network not found');

  await execFileAsync('docker', ['pull', '--quiet', CURL_IMAGE], { timeout: 300000 });
});

test('the stack answers the diagnostic form through nginx', async () => {
  const body = await curlThroughNginx();
  assert.equal(body.status, 'ok', 'the api must be healthy before the rest of this suite means anything');
  assert.ok(body.client, 'the diagnostic form must report the resolved client address');
  assert.ok(isPrivateV4(body.client.ip), `resolved ip should be a bridge address, got ${body.client.ip}`);
});

test('a client-supplied X-Forwarded-For is discarded, not trusted', async () => {
  const body = await curlThroughNginx({ spoof: SPOOFED });

  assert.notEqual(
    body.client.ip,
    SPOOFED,
    'THE SPOOF WAS BELIEVED. A client can choose its own rate-limit bucket and ' +
      'its own logged address. Check proxy_set_header X-Forwarded-For $remote_addr ' +
      'and that no set_real_ip_from range covers the bridge.'
  );
  assert.ok(
    isPrivateV4(body.client.ip),
    `resolved ip must be the connecting address, got ${body.client.ip}`
  );

  // Nginx OVERWRITES rather than appends, so the header the app sees carries
  // exactly one address and the spoofed value is absent entirely - it was not
  // merely out-counted by the hop arithmetic.
  assert.equal(
    body.client.forwardedFor.includes(','),
    false,
    `X-Forwarded-For must be overwritten, not appended: ${body.client.forwardedFor}`
  );
  assert.equal(
    body.client.forwardedFor.includes(SPOOFED),
    false,
    'the spoofed value must not survive into the header at all'
  );
  assert.equal(
    body.client.forwardedFor,
    body.client.ip,
    'with one proxy overwriting the header, the resolved ip is the header value'
  );
});

test('a spoofed X-Forwarded-For cannot impersonate a second hop either', async () => {
  // The append-shaped attack: send two addresses so that if anything appended
  // to the header, or if trust proxy counted more hops than exist, an
  // attacker-chosen value would end up in the trusted position.
  const body = await curlThroughNginx({ spoof: `${SPOOFED}, 198.51.100.9` });

  assert.equal(body.client.ip.includes('203.0.113'), false);
  assert.equal(body.client.ip.includes('198.51.100'), false);
  assert.ok(isPrivateV4(body.client.ip));
});

test('distinct clients resolve to distinct addresses', async () => {
  // Run both containers at the same time. Docker reuses addresses once a
  // container exits, so sequential runs could legitimately collide and would
  // prove nothing.
  const [a, b] = await Promise.all([
    curlThroughNginx({ spoof: SPOOFED }),
    curlThroughNginx({ spoof: SPOOFED }),
  ]);

  assert.ok(isPrivateV4(a.client.ip));
  assert.ok(isPrivateV4(b.client.ip));
  assert.notEqual(
    a.client.ip,
    b.client.ip,
    'two concurrent clients resolved to the same address, so they would share one ' +
      'rate-limit bucket - trust proxy is collapsing every visitor into the proxy IP'
  );
});
