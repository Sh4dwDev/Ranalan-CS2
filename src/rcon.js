import { connect } from 'node:net';

const AUTH = 3;
const EXEC = 2;
const AUTH_ID = 1;
const EXEC_ID = 2;

function packet(id, type, body) {
  const text = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + text.length);
  buf.writeInt32LE(10 + text.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  text.copy(buf, 12);
  return buf;
}

// Sends one command with the Source RCON protocol and resolves once the server has
// accepted it. The reply text is ignored, since load commands may not send one.
export function sendRcon({ host, port, password, command, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let buffer = Buffer.alloc(0);
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };

    socket.setTimeout(timeoutMs, () => finish(new Error('Fikk ikke svar fra serveren (tidsavbrudd).')));
    socket.on('error', (err) => finish(new Error(`Kunne ikke koble til serveren: ${err.message}`)));
    socket.on('connect', () => socket.write(packet(AUTH_ID, AUTH, password)));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readInt32LE(0);
        if (buffer.length < size + 4) return;
        const id = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        buffer = buffer.subarray(size + 4);

        if (type === 2 && id === -1) {
          finish(new Error('Serveren godtok ikke RCON-passordet.'));
          return;
        }
        if (type === 2 && id === AUTH_ID) {
          socket.write(packet(EXEC_ID, EXEC, command));
          // Some commands never reply, so give it a moment and then count it as sent.
          setTimeout(() => finish(), 1000);
        }
        if (id === EXEC_ID) finish();
      }
    });
  });
}
