jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('../services/linux-vpn-session', () => ({
    protectedVpnSession: jest.fn(() => false),
}));

import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import {
    createMpvIpcEndpoint,
    createPrivatePlayerIpcEndpoint,
    disposePrivatePlayerIpcEndpoints,
    spawnPlayerWithEndpoint,
} from './mpv-ipc-endpoint';
import { protectedVpnSession } from '../services/linux-vpn-session';

describe('MPV IPC endpoint', () => {
    it('isolates each launch and removes only its directory on child exit', () => {
        const first = createMpvIpcEndpoint();
        const second = createMpvIpcEndpoint();
        if (!first || !second)
            throw new Error('Synthetic IPC endpoint unavailable');
        try {
            expect(first.path).not.toBe(second.path);
            if (process.platform === 'win32') {
                expect(first.path).toMatch(/^\\\\\.\\pipe\\iptvnator-mpv-/);
                return;
            }
            const directory = dirname(first.path);
            expect(statSync(directory).mode & 0o777).toBe(0o700);
            const child = new EventEmitter();
            jest.mocked(spawn).mockReturnValueOnce(child as ChildProcess);
            spawnPlayerWithEndpoint('/synthetic/mpv', [], false, first);
            child.emit('exit', 0);
            expect(existsSync(directory)).toBe(false);
            expect(existsSync(dirname(second.path))).toBe(true);
        } finally {
            first.dispose();
            second.dispose();
        }
    });

    it('releases the allocated directory when spawning throws', () => {
        const endpoint = createMpvIpcEndpoint();
        if (!endpoint) throw new Error('Synthetic IPC endpoint unavailable');
        try {
            jest.mocked(spawn).mockImplementationOnce(() => {
                throw new Error('Synthetic spawn error');
            });
            expect(() =>
                spawnPlayerWithEndpoint('/synthetic/mpv', [], false, endpoint)
            ).toThrow('Synthetic spawn error');
            if (process.platform !== 'win32')
                expect(existsSync(dirname(endpoint.path))).toBe(false);
        } finally {
            endpoint.dispose();
        }
    });

    it('cleans up detached Unix sockets on app quit without stopping players', () => {
        if (process.platform === 'win32') return;
        const endpoints = [
            createPrivatePlayerIpcEndpoint('mpv'),
            createPrivatePlayerIpcEndpoint('vlc'),
        ];
        const kill = jest.fn();
        try {
            for (const endpoint of endpoints) {
                if (!endpoint)
                    throw new Error('Synthetic IPC endpoint unavailable');
                const child = Object.assign(new EventEmitter(), { kill });
                jest.mocked(spawn).mockReturnValueOnce(
                    child as unknown as ChildProcess
                );
                spawnPlayerWithEndpoint(
                    '/synthetic/player',
                    [],
                    false,
                    endpoint
                );
                expect(existsSync(dirname(endpoint.path))).toBe(true);
            }
            disposePrivatePlayerIpcEndpoints();
            for (const endpoint of endpoints) {
                if (endpoint)
                    expect(existsSync(dirname(endpoint.path))).toBe(false);
            }
            expect(kill).not.toHaveBeenCalled();
        } finally {
            endpoints.forEach((endpoint) => endpoint?.dispose());
        }
    });

    it('never spawns a host-side player during a protected VPN session', () => {
        const endpoint = createPrivatePlayerIpcEndpoint('vlc');
        jest.mocked(spawn).mockClear();
        jest.mocked(protectedVpnSession).mockReturnValue(true);
        try {
            expect(() =>
                spawnPlayerWithEndpoint(
                    'flatpak-spawn',
                    ['--host', 'vlc'],
                    false,
                    endpoint
                )
            ).toThrow('Use the built-in player while app VPN is on.');
            expect(spawn).not.toHaveBeenCalled();
            if (endpoint && process.platform !== 'win32')
                expect(existsSync(dirname(endpoint.path))).toBe(false);
        } finally {
            jest.mocked(protectedVpnSession).mockReturnValue(false);
            endpoint?.dispose();
        }
    });
});
