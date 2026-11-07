import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { sendRcon } from '../src/rcon.js';

function reply(id, type) {
  const buf = Buffer.alloc(14);
  buf.writeInt32LE(10, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  return buf;
}

function fakeServer(password) {
  const commands = [];
  const server = createServer((socket) => {
    socket.on('data', (data) => {
      const id = data.readInt32LE(4);
      const type = data.readInt32LE(8);
      const body = data.subarray(12, data.length - 2).toString();
      if (type === 3) {
        socket.write(reply(body === password ? id : -1, 2));
      } else {
        commands.push(body);
        socket.write(reply(id, 0));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, commands, port: server.address().port }));
  });
}

test('logs in and sends the command', async () => {
  const { server, commands, port } = await fakeServer('secret');
  await sendRcon({ host: '127.0.0.1', port, password: 'secret', command: 'matchzy_loadmatch_url "http://x"' });
  assert.deepEqual(commands, ['matchzy_loadmatch_url "http://x"']);
  server.close();
});

test('reports a wrong password', async () => {
  const { server, commands, port } = await fakeServer('secret');
  await assert.rejects(
    sendRcon({ host: '127.0.0.1', port, password: 'wrong', command: 'status' }),
    /RCON-passordet/,
  );
  assert.deepEqual(commands, []);
  server.close();
});

test('reports a server that is down', async () => {
  await assert.rejects(
    sendRcon({ host: '127.0.0.1', port: 1, password: 'x', command: 'status', timeoutMs: 1000 }),
    /Kunne ikke koble til|tidsavbrudd/,
  );
});
