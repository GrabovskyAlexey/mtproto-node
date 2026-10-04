import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { probeSocksTunnel } from '../src/services/socks-probe.ts';

async function fixture(reply, run, httpStatus = '204 No Content') {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let phase = 0;
    socket.on('data', data => {
      if (phase === 0) { phase++; socket.write(Buffer.from([5])); setTimeout(() => socket.write(Buffer.from([0])), 5); }
      else if (phase === 1) {
        phase++;
        assert.equal(data[3], 3);
        assert.equal(data.subarray(5, 5 + data[4]).toString(), 'www.gstatic.com');
        socket.write(reply.subarray(0, 3));
        setTimeout(() => socket.write(reply.subarray(3)), 5);
      } else socket.write(`HTTP/1.1 ${httpStatus}\r\nConnection: close\r\n\r\n`);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(server.address().port); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
}
for (const reply of [Buffer.from([5,0,0,1,127,0,0,1,0,1]), Buffer.from([5,0,0,3,3,97,98,99,0,1]), Buffer.concat([Buffer.from([5,0,0,4]),Buffer.alloc(18)])]) {
  test(`fragmented SOCKS reply type ${reply[3]} completes HTTP probe`, async () => {
    await fixture(reply, async port => assert.ok(await probeSocksTunnel('127.0.0.1', port, { connectTLS: socket => { queueMicrotask(() => socket.emit('secureConnect')); return socket; } }) >= 0));
  });
}
test('rejected SOCKS connection fails', async () => {
  await fixture(Buffer.from([5,5,0,1,0,0,0,0,0,0]), async port => assert.rejects(probeSocksTunnel('127.0.0.1', port)));
});
test('HTTP failure cannot be reported as a connected tunnel', async () => {
  await fixture(Buffer.from([5,0,0,1,127,0,0,1,0,1]), async port => assert.rejects(probeSocksTunnel('127.0.0.1', port, { connectTLS: socket => { queueMicrotask(() => socket.emit('secureConnect')); return socket; } })), '502 Bad Gateway');
});
test('default connector rejects a plaintext response instead of treating it as HTTPS', async () => {
  await fixture(Buffer.from([5,0,0,1,127,0,0,1,0,1]), async port => assert.rejects(probeSocksTunnel('127.0.0.1', port)));
});
test('deadline terminates a stalled handshake', async () => {
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await assert.rejects(probeSocksTunnel('127.0.0.1', server.address().port, { timeoutMs: 20 }), /deadline/); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
});
