/**
 * `xmltv.php`: the provider's guide, scrubbed, cached on disk and streamed.
 *
 * The provider's answer is decoded whatever its encoding (gzip, deflate or
 * none), scrubbed of the provider host and account as it streams (a guide
 * can name the panel in `generator-info-url` or icon URLs), and stored
 * gzip-compressed. A client that accepts gzip gets the stored bytes as they
 * are; others get them decompressed. A stale guide is served at once and
 * refreshed in the background, and kept when the provider is down. A
 * client asking while there is no copy yet receives the guide as it is
 * downloaded.
 */

import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import {
    PassThrough,
    Readable,
    Transform,
    TransformCallback,
} from 'node:stream';
import { createGunzip, createGzip } from 'node:zlib';
import { RelayLogger } from '../relay-log';
import { DiskCache } from './api-cache';
import { ProviderApi } from './provider-api';
import { ProviderSanitizer } from './sanitize';

const KEY = 'xmltv';
const CONTENT_TYPE = 'application/xml; charset=utf-8';

/** Replaces secrets across chunk boundaries; rejects a non-XML body. */
export class ScrubTransform extends Transform {
    private readonly decoder = new StringDecoder('utf8');
    private carry = '';
    private checked = false;

    constructor(private readonly sanitizer: ProviderSanitizer) {
        super();
    }

    override _transform(
        chunk: Buffer,
        _: BufferEncoding,
        done: TransformCallback
    ): void {
        this.carry += this.decoder.write(chunk);
        if (!this.checked && this.carry.trim().length > 0) {
            this.checked = true;
            if (!this.carry.trimStart().startsWith('<')) {
                done(new Error('not-xml'));
                return;
            }
        }
        // Whole secrets are replaced; the tail that could be the start of
        // one split by the next chunk is held back.
        this.carry = this.sanitizer.scrubText(this.carry);
        const keep = Math.max(0, this.sanitizer.longestSecret - 1);
        if (this.carry.length > keep) {
            this.push(this.carry.slice(0, this.carry.length - keep));
            this.carry = this.carry.slice(this.carry.length - keep);
        }
        done();
    }

    override _flush(done: TransformCallback): void {
        this.carry += this.decoder.end();
        if (!this.checked) {
            done(new Error('not-xml'));
            return;
        }
        this.push(this.sanitizer.scrubText(this.carry));
        this.carry = '';
        done();
    }
}

/** A client reading a download while it is written. */
interface Tee {
    readonly out: PassThrough;
    readonly gzip: boolean;
}

/** A reader that falls this far behind the download is cut off. */
const MAX_TEE_BUFFER = 16 * 1024 * 1024;

export class XmltvProxy {
    private download: Promise<void> | null = null;

    constructor(
        private readonly api: ProviderApi,
        private readonly cache: DiskCache,
        private readonly sanitizer: ProviderSanitizer,
        private readonly ttlMs: number,
        private readonly log?: RelayLogger,
        private readonly now: () => number = Date.now
    ) {}

    async serve(
        request: IncomingMessage,
        response: ServerResponse
    ): Promise<void> {
        const stats = this.cache.statsFor('xmltv');
        const gzip = /\bgzip\b/.test(
            String(request.headers['accept-encoding'] ?? '')
        );
        const file = this.cache.fileFor(KEY);
        const stat = await fs.stat(file).catch(() => null);
        if (stat) {
            const ageMs = Math.max(0, this.now() - stat.mtimeMs);
            stats.lastAgeSec = Math.round(ageMs / 1000);
            if (ageMs < this.ttlMs) {
                stats.hits += 1;
            } else {
                stats.stale += 1;
                this.refresh().catch(() => undefined);
            }
            this.sendFile(request, response, file, gzip);
            return;
        }
        stats.misses += 1;
        if (!this.download && request.method !== 'HEAD') {
            // The first client reads the guide as it downloads.
            const out = new PassThrough();
            const running = this.refresh({ out, gzip });
            running.catch(() => undefined);
            this.sendStream(request, response, out, gzip);
            return;
        }
        try {
            await this.refresh();
            this.sendFile(request, response, file, gzip);
        } catch {
            response.writeHead(502, { 'Cache-Control': 'no-store' });
            response.end();
        }
    }

    /** One download at a time; resolves once the new copy is stored. */
    refresh(tee?: Tee): Promise<void> {
        this.download ??= this.fetch(tee).finally(() => {
            this.download = null;
        });
        return this.download;
    }

    private async fetch(tee?: Tee): Promise<void> {
        const stats = this.cache.statsFor('xmltv');
        await this.cache.ensureDir();
        const temp = this.cache.tempPath();
        let source: Readable;
        try {
            source = await this.api.xmltv();
        } catch (error) {
            stats.errors += 1;
            tee?.out.destroy();
            this.log?.warn(
                `xmltv download failed: ${(error as { kind?: string }).kind ?? 'Error'}`
            );
            throw error;
        }
        const scrub = new ScrubTransform(this.sanitizer);
        const compress = createGzip();
        const out = createWriteStream(temp, { mode: 0o600 });
        source.pipe(scrub).pipe(compress).pipe(out);
        if (tee) {
            tee.out.on('error', () => undefined);
            (tee.gzip ? compress : scrub).on('data', (chunk: Buffer) => {
                if (tee.out.destroyed) {
                    return;
                }
                tee.out.write(chunk);
                if (tee.out.writableLength > MAX_TEE_BUFFER) {
                    tee.out.destroy();
                }
            });
        }
        try {
            await new Promise<void>((resolve, reject) => {
                const fail = (error: Error) => reject(error);
                source.once('error', fail);
                scrub.once('error', fail);
                compress.once('error', fail);
                out.once('error', fail);
                out.once('finish', () => resolve());
            });
            tee?.out.end();
            await this.cache.commit(temp, KEY);
            this.log?.info('xmltv refreshed');
        } catch (error) {
            stats.errors += 1;
            source.destroy();
            tee?.out.destroy();
            await fs.rm(temp, { force: true });
            this.log?.warn(
                `xmltv download failed: ${(error as Error).message === 'not-xml' ? 'not-xml' : 'stream'}`
            );
            throw error;
        }
    }

    private sendFile(
        request: IncomingMessage,
        response: ServerResponse,
        file: string,
        gzip: boolean
    ): void {
        const stream = createReadStream(file);
        this.sendStream(
            request,
            response,
            gzip ? stream : stream.pipe(createGunzip()),
            gzip
        );
    }

    private sendStream(
        request: IncomingMessage,
        response: ServerResponse,
        body: Readable,
        gzip: boolean
    ): void {
        response.writeHead(200, {
            'Content-Type': CONTENT_TYPE,
            'Cache-Control': 'no-store',
            ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
        });
        if (request.method === 'HEAD') {
            response.end();
            body.destroy();
            return;
        }
        body.on('error', () => response.destroy());
        response.once('close', () => body.destroy());
        body.pipe(response);
    }
}
