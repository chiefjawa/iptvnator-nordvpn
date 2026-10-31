import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
jest.mock('./linux-vpn-helper', () => ({ runVpnHelper: jest.fn() }));
import { runVpnHelper } from './linux-vpn-helper';
import { createVpnLaunchGuard, stopVpnLaunch } from './linux-vpn-launch-guard';

(process.platform === 'linux' ? describe : describe.skip)(
    'VPN launch cancellation',
    () => {
        let directory: string;
        beforeEach(() => {
            directory = mkdtempSync(join(tmpdir(), 'iptvnator-guard-'));
            jest.clearAllMocks();
        });
        afterEach(() => rmSync(directory, { recursive: true, force: true }));

        it('never executes the player if a delayed launch arrives after cancellation', () => {
            const guard = createVpnLaunchGuard(directory, [
                process.execPath,
                '-e',
                'process.stdout.write("started")',
            ]);
            expect(
                execFileSync(guard.args[0], guard.args.slice(1), {
                    encoding: 'utf8',
                })
            ).toBe('started');
            guard.cancel();
            expect(guard.allowed()).toBe(false);
            expect(() =>
                execFileSync(guard.args[0], guard.args.slice(1))
            ).toThrow();
        });
        it('stops only its own application and preserves another player sharing the namespace', async () => {
            let stopped = false;
            const other = { pid: 99, argv: ['/bin/other-player'] };
            jest.mocked(runVpnHelper).mockImplementation(async (args) => {
                if (args[0] === 'stop') {
                    stopped = true;
                    return '{"success":true}';
                }
                return JSON.stringify({
                    namespaces: [
                        {
                            id: 'owned-u1000',
                            applications: stopped
                                ? [other]
                                : [
                                      other,
                                      {
                                          pid: 123,
                                          argv: [
                                              '/bin/sh',
                                              '/private/launch.sh',
                                          ],
                                      },
                                  ],
                        },
                    ],
                });
            });
            expect(
                await stopVpnLaunch(
                    'owned-u1000',
                    '/private/launch.sh',
                    () => stopped
                )
            ).toBe(true);
            expect(runVpnHelper).toHaveBeenCalledWith([
                'stop',
                'application',
                '123',
                '--json',
            ]);
            expect(runVpnHelper).not.toHaveBeenCalledWith([
                'stop',
                'application',
                '99',
                '--json',
            ]);
            expect(runVpnHelper).not.toHaveBeenCalledWith([
                'stop',
                'namespace',
                'owned-u1000',
                '--json',
            ]);
        });
    }
);
