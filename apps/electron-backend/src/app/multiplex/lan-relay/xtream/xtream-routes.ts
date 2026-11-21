/**
 * Stream URL forms players use with an Xtream panel, and local logins.
 *
 *   /live/<user>/<pass>/<id>[.ts|.m3u8]   /<user>/<pass>/<id>[.ts]
 *   /movie/<user>/<pass>/<id>.<ext>       /series/<user>/<pass>/<id>.<ext>
 *   /timeshift/<user>/<pass>/<minutes>/<start>/<id>.<ext>
 *   /streaming/timeshift.php?username&password&stream&start&duration
 */

import { timingSafeEqual } from 'node:crypto';
import { RelayClientLogin } from '../relay-config-front';

export type StreamRoute =
    | {
          readonly kind: 'live';
          readonly user: string;
          readonly pass: string;
          readonly streamId: number;
          readonly ext: 'ts' | 'm3u8';
      }
    | {
          readonly kind: 'movie' | 'series';
          readonly user: string;
          readonly pass: string;
          readonly id: string;
          readonly ext: string;
      }
    | {
          readonly kind: 'timeshift';
          readonly user: string;
          readonly pass: string;
          readonly minutes: string;
          readonly start: string;
          readonly id: string;
          readonly ext: string;
      };

const ID = /^\d{1,12}$/;
const ID_EXT = /^(\d{1,12})\.([A-Za-z0-9]{1,5})$/;
const LIVE_ID = /^(\d{1,12})(?:\.(ts|m3u8))?$/;
const START = /^[0-9][0-9:_-]{3,24}$/;

export function parseStreamPath(path: string): StreamRoute | null {
    const parts = path.split('/').slice(1).map(safeDecode);
    if (parts.some((part) => part === null || part === '')) {
        return null;
    }
    const seg = parts as string[];
    if (seg.length === 4 && seg[0] === 'live') {
        return live(seg[1], seg[2], seg[3]);
    }
    if (seg.length === 3) {
        return live(seg[0], seg[1], seg[2]);
    }
    if (seg.length === 4 && (seg[0] === 'movie' || seg[0] === 'series')) {
        const match = ID_EXT.exec(seg[3]);
        return match
            ? {
                  kind: seg[0],
                  user: seg[1],
                  pass: seg[2],
                  id: match[1],
                  ext: match[2],
              }
            : null;
    }
    if (seg.length === 6 && seg[0] === 'timeshift') {
        const match = ID_EXT.exec(seg[5]);
        if (match && ID.test(seg[3]) && START.test(seg[4])) {
            return {
                kind: 'timeshift',
                user: seg[1],
                pass: seg[2],
                minutes: seg[3],
                start: seg[4],
                id: match[1],
                ext: match[2],
            };
        }
    }
    return null;
}

/** `/streaming/timeshift.php` query form. */
export function parseTimeshiftQuery(
    query: URLSearchParams
): StreamRoute | null {
    const stream = query.get('stream') ?? '';
    const minutes = query.get('duration') ?? '';
    const start = query.get('start') ?? '';
    const match = /^(\d{1,12})(?:\.([A-Za-z0-9]{1,5}))?$/.exec(stream);
    if (!match || !ID.test(minutes) || !START.test(start)) {
        return null;
    }
    return {
        kind: 'timeshift',
        user: query.get('username') ?? '',
        pass: query.get('password') ?? '',
        minutes,
        start,
        id: match[1],
        ext: match[2] ?? 'ts',
    };
}

function live(user: string, pass: string, last: string): StreamRoute | null {
    const match = LIVE_ID.exec(last);
    if (!match) {
        return null;
    }
    return {
        kind: 'live',
        user,
        pass,
        streamId: Number(match[1]),
        ext: match[2] === 'm3u8' ? 'm3u8' : 'ts',
    };
}

/** The matching local login, compared in constant time. */
export function authenticate(
    clients: readonly RelayClientLogin[],
    username: string | null | undefined,
    password: string | null | undefined
): RelayClientLogin | null {
    if (!username || !password) {
        return null;
    }
    let found: RelayClientLogin | null = null;
    for (const client of clients) {
        const userOk = same(username, client.username);
        const passOk = same(password, client.password);
        if (userOk && passOk) {
            found = client;
        }
    }
    return found;
}

function same(given: string, expected: string): boolean {
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

function safeDecode(part: string): string | null {
    try {
        return decodeURIComponent(part);
    } catch {
        return null;
    }
}
