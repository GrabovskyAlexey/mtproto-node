import net from 'node:net';
import tls from 'node:tls';

const TARGET = 'www.gstatic.com';
type Options = { connectTLS?: (socket: net.Socket) => net.Socket; timeoutMs?: number };

/** Verify actual HTTPS reachability through SOCKS; a successful CONNECT alone is insufficient. */
export function probeSocksTunnel(host: string, port = 10808, options: Options = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    let secure: net.Socket | undefined;
    let finished = false;
    let phase: 'greeting' | 'connect' | 'http' = 'greeting';
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('Tunnel deadline exceeded')), options.timeoutMs ?? 5000);
    function finish(error?: Error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.removeListener('data', receive);
      secure?.removeListener('data', receive);
      secure?.destroy(); socket.destroy();
      if (error) reject(error); else resolve(Date.now() - started);
    }
    function beginTLS() {
      socket.removeListener('data', receive);
      if (buffer.length) socket.unshift(buffer);
      buffer = Buffer.alloc(0);
      phase = 'http';
      secure = options.connectTLS ? options.connectTLS(socket) : tls.connect({ socket, servername: TARGET, rejectUnauthorized: true });
      secure.once('error', error => finish(error));
      secure.once('close', () => finish(new Error('Tunnel closed')));
      secure.on('data', receive);
      secure.once('secureConnect', () => secure!.write(`GET /generate_204 HTTP/1.1\r\nHost: ${TARGET}\r\nConnection: close\r\n\r\n`));
    }
    function receive(data: Buffer) {
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length > 16384) return finish(new Error('Oversized tunnel response'));
      if (phase === 'greeting') {
        if (buffer.length < 2) return;
        if (buffer[0] !== 5 || buffer[1] !== 0) return finish(new Error('SOCKS authentication rejected'));
        buffer = buffer.subarray(2);
        phase = 'connect';
        const domain = Buffer.from(TARGET);
        socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, domain.length]), domain, Buffer.from([1, 187])]));
      }
      if (phase === 'connect') {
        if (buffer.length < 4) return;
        if (buffer[0] !== 5 || buffer[1] !== 0 || buffer[2] !== 0) return finish(new Error('SOCKS connection rejected'));
        const addressType = buffer[3];
        if (addressType === 3 && buffer.length < 5) return;
        const length = addressType === 1 ? 10 : addressType === 4 ? 22 : addressType === 3 ? 7 + buffer[4] : 0;
        if (!length) return finish(new Error('Invalid SOCKS address'));
        if (buffer.length < length) return;
        buffer = buffer.subarray(length);
        return beginTLS();
      }
      if (phase === 'http') {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        if (!/^HTTP\/1\.[01] 204(?: |\r\n)/.test(buffer.subarray(0, end + 4).toString('ascii'))) return finish(new Error('HTTPS probe failed'));
        finish();
      }
    }
    socket.once('error', error => finish(error));
    socket.once('close', () => finish(new Error('Tunnel closed')));
    socket.on('data', receive);
    socket.once('connect', () => socket.write(Buffer.from([5, 1, 0])));
  });
}
