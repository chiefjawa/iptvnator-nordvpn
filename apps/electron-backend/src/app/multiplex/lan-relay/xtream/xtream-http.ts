/**
 * HTTP handlers of the Xtream-compatible front.
 *
 * Unknown local logins get what a real panel answers: `user_info.auth = 0`
 * from the API, 401 for the guide and playlist, 403 for streams. Nothing
 * here ever writes a provider header, URL or account to the client.
 */

import { IncomingMessage, ServerResponse } from 'node:http';
import type { RelayApp } from '../relay-app';
import { buildProviderUrl } from '../relay-config';
import { serveLive } from '../relay-live-http';
import { clientAddress } from '../relay-listen';
import { buildM3uPlus } from './m3u';
import { RenderContext } from './sanitize';
import { BAD_LOGIN } from './xtream-front';
import {
    authenticate,
    parseStreamPath,
    parseTimeshiftQuery,
    StreamRoute,
} from './xtream-routes';

const MAX_FORM_BYTES = 16 * 1024;

export type Origin = { origin: string; host: string };

/** Handles an Xtream path; false when the path is not one of them. */
export async function handleXtream(
    app: RelayApp,
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
    query: URLSearchParams,
    origin: Origin
): Promise<boolean> {
    const clients = app.deps.config.clients;
    if (path === '/player_api.php') {
        const params =
            request.method === 'POST' ? await readForm(request, query) : query;
        if (!params) {
            send(response, 413, 'application/json', '[]');
            return true;
        }
        const login = authenticate(
            clients,
            params.get('username'),
            params.get('password')
        );
        if (!login) {
            app.http.unauthorized += 1;
            send(response, 200, 'application/json', BAD_LOGIN);
            return true;
        }
        const answer = await app.front.playerApi(
            params,
            context(origin, login)
        );
        send(
            response,
            answer.status,
            'application/json',
            answer.body,
            request.method === 'HEAD'
        );
        return true;
    }
    if (path === '/xmltv.php' || path === '/get.php') {
        const login = authenticate(
            clients,
            query.get('username'),
            query.get('password')
        );
        if (!login) {
            app.http.unauthorized += 1;
            send(response, 401, 'text/plain', '');
            return true;
        }
        if (path === '/xmltv.php') {
            await app.xmltv.serve(request, response);
            return true;
        }
        try {
            const body = await buildM3uPlus(app.front, context(origin, login));
            send(
                response,
                200,
                'audio/x-mpegurl; charset=utf-8',
                body,
                request.method === 'HEAD'
            );
        } catch {
            send(response, 502, 'text/plain', '');
        }
        return true;
    }
    const route =
        path === '/streaming/timeshift.php'
            ? parseTimeshiftQuery(query)
            : parseStreamPath(path);
    if (!route) {
        return false;
    }
    if (!authenticate(clients, route.user, route.pass)) {
        app.http.unauthorized += 1;
        send(response, 403, 'text/plain', '');
        return true;
    }
    const remote = clientAddress(request.socket);
    if (route.kind === 'live') {
        if (route.ext === 'm3u8') {
            app.http.m3u8Refused += 1;
            app.deps.log?.warn(
                `live ${route.streamId} from ${remote} asked for HLS (.m3u8); the relay serves MPEG-TS only — set the player's stream format to TS`
            );
            send(response, 404, 'text/plain', '');
            return true;
        }
        serveLive(app.relay, request, response, route.streamId);
        return true;
    }
    await app.vod.handle(
        {
            url: providerUrl(app, route),
            method: request.method === 'HEAD' ? 'HEAD' : 'GET',
            range: header(request, 'range'),
            ifRange: header(request, 'if-range'),
            userAgent: app.deps.config.userAgent,
            sessionKey: `${remote}|${route.kind}|${itemOf(route)}`,
            label: `${route.kind}:${itemOf(route)}`,
            remote,
        },
        response
    );
    return true;
}

function providerUrl(
    app: RelayApp,
    route: Exclude<StreamRoute, { kind: 'live' }>
): string {
    const config = app.deps.config;
    if (route.kind === 'timeshift') {
        return buildProviderUrl(config, 'timeshift', [
            route.minutes,
            route.start,
            `${route.id}.${route.ext}`,
        ]);
    }
    return buildProviderUrl(config, route.kind, [`${route.id}.${route.ext}`]);
}

function itemOf(route: Exclude<StreamRoute, { kind: 'live' }>): string {
    return route.kind === 'timeshift'
        ? `${route.id}@${route.start}+${route.minutes}`
        : route.id;
}

function context(
    origin: Origin,
    login: { username: string; password: string }
): RenderContext {
    return { ...origin, username: login.username, password: login.password };
}

function header(request: IncomingMessage, name: string): string | undefined {
    const value = request.headers[name];
    return typeof value === 'string' && value.length < 256 ? value : undefined;
}

/** A url-encoded POST body merged over the query string. */
async function readForm(
    request: IncomingMessage,
    query: URLSearchParams
): Promise<URLSearchParams | null> {
    let body = '';
    for await (const chunk of request) {
        body += chunk;
        if (body.length > MAX_FORM_BYTES) {
            return null;
        }
    }
    const merged = new URLSearchParams(query);
    for (const [name, value] of new URLSearchParams(body)) {
        merged.set(name, value);
    }
    return merged;
}

export function send(
    response: ServerResponse,
    status: number,
    type: string,
    body: string,
    headOnly = false
): void {
    response.writeHead(status, {
        'Content-Type': type,
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    response.end(headOnly ? undefined : body);
}
