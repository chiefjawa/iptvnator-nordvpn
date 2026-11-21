/**
 * Disk cache of sanitized provider answers, with stale-while-revalidate.
 *
 * A fresh entry is served as is. A stale one is served at once and
 * refreshed in the background; if the provider is down the stale copy keeps
 * being served. Without any copy the request waits for the provider. One
 * refresh per key runs at a time. Files are written to a temporary name and
 * renamed, so a crash never leaves a torn entry, and the directory is kept
 * under its byte budget by removing the oldest files.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export interface CacheHit {
    readonly body: Buffer;
    readonly ageMs: number;
    readonly state: 'fresh' | 'stale' | 'origin';
}

export interface CacheClassStats {
    hits: number;
    stale: number;
    misses: number;
    errors: number;
    /** Age of the most recently served entry, in seconds. */
    lastAgeSec: number | null;
}

type Fetcher = () => Promise<Buffer>;

export class DiskCache {
    private readonly refreshing = new Map<string, Promise<Buffer>>();
    private readonly stats = new Map<string, CacheClassStats>();
    private writesSincePrune = 0;
    private ready: Promise<void> | null = null;

    constructor(
        private readonly dir: string,
        private readonly maxBytes: number,
        private readonly now: () => number = Date.now,
        private readonly onError?: (what: string) => void
    ) {}

    /**
     * The entry for `key` under the stats class `group`, refreshed through
     * `fetch` when older than `ttlMs`. Throws only when there is no copy and
     * the fetch fails.
     */
    async get(
        group: string,
        key: string,
        ttlMs: number,
        fetch: Fetcher
    ): Promise<CacheHit> {
        const stats = this.statsFor(group);
        const file = this.fileFor(key);
        const cached = await this.read(file);
        if (cached) {
            const ageMs = Math.max(0, this.now() - cached.mtimeMs);
            stats.lastAgeSec = Math.round(ageMs / 1000);
            if (ageMs < ttlMs) {
                stats.hits += 1;
                return { body: cached.body, ageMs, state: 'fresh' };
            }
            stats.stale += 1;
            this.refresh(key, file, fetch).catch(() => {
                stats.errors += 1;
            });
            return { body: cached.body, ageMs, state: 'stale' };
        }
        stats.misses += 1;
        try {
            const body = await this.refresh(key, file, fetch);
            stats.lastAgeSec = 0;
            return { body, ageMs: 0, state: 'origin' };
        } catch (error) {
            stats.errors += 1;
            throw error;
        }
    }

    /** Path of the entry's file, for streaming large bodies. */
    fileFor(key: string): string {
        const hash = createHash('sha256').update(key).digest('hex');
        return join(this.dir, `${hash.slice(0, 40)}.cache`);
    }

    /** Stores a body written elsewhere (`tempPath`) as the entry for `key`. */
    async commit(tempPath: string, key: string): Promise<void> {
        await fs.rename(tempPath, this.fileFor(key));
        this.notePrune();
    }

    async ensureDir(): Promise<void> {
        this.ready ??= fs
            .mkdir(this.dir, { recursive: true, mode: 0o700 })
            .then(() => undefined);
        return this.ready;
    }

    tempPath(): string {
        return join(
            this.dir,
            `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
        );
    }

    status(): Record<string, CacheClassStats> {
        return Object.fromEntries(
            [...this.stats].map(([group, stats]) => [group, { ...stats }])
        );
    }

    statsFor(group: string): CacheClassStats {
        let stats = this.stats.get(group);
        if (!stats) {
            stats = {
                hits: 0,
                stale: 0,
                misses: 0,
                errors: 0,
                lastAgeSec: null,
            };
            this.stats.set(group, stats);
        }
        return stats;
    }

    private refresh(
        key: string,
        file: string,
        fetch: Fetcher
    ): Promise<Buffer> {
        const running = this.refreshing.get(key);
        if (running) {
            return running;
        }
        const task = (async () => {
            const body = await fetch();
            await this.write(file, body);
            return body;
        })().finally(() => this.refreshing.delete(key));
        this.refreshing.set(key, task);
        return task;
    }

    private async read(
        file: string
    ): Promise<{ body: Buffer; mtimeMs: number } | null> {
        try {
            const [body, stat] = await Promise.all([
                fs.readFile(file),
                fs.stat(file),
            ]);
            return { body, mtimeMs: stat.mtimeMs };
        } catch {
            return null;
        }
    }

    private async write(file: string, body: Buffer): Promise<void> {
        try {
            await this.ensureDir();
            const temp = this.tempPath();
            await fs.writeFile(temp, body, { mode: 0o600 });
            await fs.rename(temp, file);
            this.notePrune();
        } catch {
            // Serving works without the disk copy; the next request retries.
            this.onError?.('cache write failed');
        }
    }

    private notePrune(): void {
        this.writesSincePrune += 1;
        if (this.writesSincePrune >= 20) {
            this.writesSincePrune = 0;
            void this.prune();
        }
    }

    /** Removes the oldest entries until the directory fits its budget. */
    async prune(): Promise<void> {
        try {
            const names = await fs.readdir(this.dir);
            const entries = await Promise.all(
                names.map(async (name) => {
                    const path = join(this.dir, name);
                    const stat = await fs.stat(path).catch(() => null);
                    return stat
                        ? { path, size: stat.size, mtime: stat.mtimeMs }
                        : null;
                })
            );
            const files = entries
                .filter((entry): entry is NonNullable<typeof entry> => !!entry)
                .sort((a, b) => b.mtime - a.mtime);
            let total = 0;
            for (const file of files) {
                total += file.size;
                const staleTemp =
                    file.path.includes('.tmp-') &&
                    this.now() - file.mtime > 3600_000;
                if (total > this.maxBytes || staleTemp) {
                    await fs.rm(file.path, { force: true });
                }
            }
        } catch {
            this.onError?.('cache prune failed');
        }
    }
}
