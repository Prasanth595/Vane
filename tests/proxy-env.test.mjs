// Run with Node 24.5.0 or later: node --test tests/proxy-env.test.mjs
// OpenSSL is used only to generate a temporary, trusted TLS test certificate.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = process.env.VANE_SOURCE || process.cwd();

// Read only the final stage: builder settings do not configure server startup.
function runtimeEnvironment(file) {
  const stage = readFileSync(path.join(root, file), 'utf8')
    .split(/^FROM /m)
    .at(-1);
  return Object.fromEntries(
    [...stage.matchAll(/^ENV (\w+)=(.*)$/gm)].map(([, key, value]) => [
      key,
      value,
    ]),
  );
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = (server, protocol = 'http') =>
  `${protocol}://127.0.0.1:${server.address().port}`;

function fetchInChild(env, urls) {
  return new Promise((resolve, reject) => {
    // Proxy opt-in is a startup setting, so use a fresh process per scenario.
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const results = [];
         for (const url of process.argv.slice(1)) {
           const response = await fetch(url, {signal: AbortSignal.timeout(5000)});
           results.push(await response.text());
         }
         console.log(JSON.stringify(results));`,
        ...urls,
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => (stdout += data));
    child.stderr.on('data', (data) => (stderr += data));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0)
        reject(new Error(`fetch process exited ${code}: ${stderr}`));
      else {
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(error);
        }
      }
    });
  });
}

for (const file of ['Dockerfile', 'Dockerfile.slim']) {
  test(`${file} backend proxy routing`, { timeout: 30000 }, async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vane-proxy-'));
    const servers = [];
    const sockets = new Set();
    t.after(() => {
      for (const socket of sockets) socket.destroy();
      for (const server of servers) server.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const keyPath = path.join(dir, 'key.pem');
    const certPath = path.join(dir, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    const tls = { key: readFileSync(keyPath), cert: readFileSync(certPath) };
    const reply = (text) => (_req, res) => res.end(text);
    async function start(server) {
      servers.push(server);
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      await listen(server);
      return server;
    }
    const directHttp = await start(http.createServer(reply('direct-http')));
    const directHttps = await start(
      https.createServer(tls, reply('direct-https')),
    );
    const proxiedHttp = await start(http.createServer(reply('proxied-http')));
    const proxiedHttps = await start(
      https.createServer(tls, reply('proxied-https')),
    );
    const connects = [];
    async function proxy(destination, label) {
      const server = http.createServer((_req, res) => {
        connects.push(label);
        res.end(`proxied-${label}`);
      });
      server.on('connect', (req, client, head) => {
        connects.push(label);
        const target = net.connect(
          destination.address().port,
          '127.0.0.1',
          () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) target.write(head);
            client.pipe(target).pipe(client);
          },
        );
        sockets.add(target);
        target.on('close', () => sockets.delete(target));
        target.on('error', () => client.destroy());
        client.on('error', () => target.destroy());
        client.on('close', () => target.destroy());
      });
      return start(server);
    }
    const httpProxy = await proxy(proxiedHttp, 'http');
    const httpsProxy = await proxy(proxiedHttps, 'https');
    // Do not inherit the caller's transport settings.
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (
        /proxy/i.test(key) ||
        key === 'NODE_OPTIONS' ||
        key === 'NODE_EXTRA_CA_CERTS'
      ) {
        delete env[key];
      }
    }
    Object.assign(env, runtimeEnvironment(file), {
      NODE_EXTRA_CA_CERTS: certPath,
    });
    const urls = [url(directHttp), url(directHttps, 'https')];
    const direct = ['direct-http', 'direct-https'];
    assert.deepEqual(
      await fetchInChild(env, urls),
      direct,
      'no proxy variables connect directly',
    );

    const configured = {
      ...env,
      HTTP_PROXY: url(httpProxy),
      HTTPS_PROXY: url(httpsProxy),
    };
    assert.deepEqual(
      await fetchInChild(configured, urls),
      ['proxied-http', 'proxied-https'],
      'configured proxy must carry HTTP and HTTPS backend requests',
    );
    assert.deepEqual(
      connects,
      ['http', 'https'],
      'each scheme uses its own proxy',
    );
    connects.length = 0;
    assert.deepEqual(
      await fetchInChild({ ...configured, NO_PROXY: '127.0.0.0/8' }, urls),
      ['proxied-http', 'proxied-https'],
      'CIDR entries do not bypass Node fetch proxies',
    );
    assert.deepEqual(connects, ['http', 'https']);
    connects.length = 0;
    assert.deepEqual(
      await fetchInChild(
        {
          ...configured,
          HTTP_PROXY: 'http://127.0.0.1:1',
          HTTPS_PROXY: 'http://127.0.0.1:1',
          NO_PROXY: '*',
          http_proxy: url(httpProxy),
          https_proxy: url(httpsProxy),
          no_proxy: 'unmatched.invalid',
        },
        urls,
      ),
      ['proxied-http', 'proxied-https'],
      'lowercase proxy settings take precedence',
    );
    assert.deepEqual(connects, ['http', 'https']);
    connects.length = 0;
    assert.deepEqual(
      await fetchInChild({ ...configured, NO_PROXY: '127.0.0.1' }, urls),
      direct,
      'NO_PROXY services connect directly',
    );
    assert.deepEqual(connects, [], 'NO_PROXY does not contact either proxy');
    assert.deepEqual(
      await fetchInChild({ ...configured, NODE_USE_ENV_PROXY: '0' }, urls),
      direct,
      'explicit opt-out connects directly',
    );
    assert.deepEqual(connects, [], 'opt-out does not contact either proxy');
  });
}
