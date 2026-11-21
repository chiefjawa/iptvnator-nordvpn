/**
 * Serves one live channel to an HTTP client: an endless, paced MPEG-TS
 * response fed by the relay, or 503 when the relay is at capacity or a
 * movie holds the connection.
 */

import { IncomingMessage, ServerResponse } from 'node:http';
import { LanRelay } from './lan-relay';
import { ClientOutput } from './relay-client';
import { clientAddress } from './relay-listen';

export function serveLive(
    relay: LanRelay,
    request: IncomingMessage,
    response: ServerResponse,
    streamId: number
): void {
    if (request.method === 'HEAD') {
        // A HEAD request does not start a channel.
        response.writeHead(200, {
            'Content-Type': 'video/mp2t',
            'Cache-Control': 'no-store',
        });
        response.end();
        return;
    }
    const output: ClientOutput = {
        write: (data) => response.write(data),
        onDrain: (listener) => response.once('drain', listener),
        close: () => response.end(),
    };
    const remote = clientAddress(request.socket);
    const result = relay.attach(streamId, output, remote);
    if (!result.client) {
        response.writeHead(503, {
            'Cache-Control': 'no-store',
            'Retry-After': '5',
        });
        response.end();
        return;
    }
    const client = result.client;
    response.writeHead(200, {
        'Content-Type': 'video/mp2t',
        'Cache-Control': 'no-store',
        Connection: 'close',
    });
    response.flushHeaders();
    request.socket.setNoDelay(true);
    request.socket.setTimeout(0);
    response.once('close', () => relay.detach(streamId, client));
}
