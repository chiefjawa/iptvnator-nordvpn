import { execFileSync } from 'node:child_process';
import {
    inVpnNamespace,
    normalizeVpnConfig,
    quoteVpnCommand,
    validVpnServer,
    vpnLaunchArguments,
    vpnNamespaceName,
} from './linux-vpn-policy';

(process.platform === 'linux' ? describe : describe.skip)(
    'Linux app VPN boundary',
    () => {
        const namespace = vpnNamespaceName('/test/profile');
        const owned = `${namespace}-u${process.getuid?.()}`;
        const env = { VOPONO_NS: owned, IPTVNATOR_VPN_HOST_NETNS: '11' };
        it('starts disabled only for genuinely missing settings', () => {
            expect(normalizeVpnConfig(undefined)).toEqual({
                enabled: false,
                configured: false,
                server: 'canada',
            });
            for (const broken of [
                null,
                [],
                'enabled',
                { enabled: 'true' },
                { configured: 1 },
                { server: '../../elsewhere' },
            ]) {
                expect(() => normalizeVpnConfig(broken)).toThrow();
            }
            expect(
                normalizeVpnConfig({
                    enabled: true,
                    configured: true,
                    server: 'canada',
                }).enabled
            ).toBe(true);
        });
        it('requires the real named kernel namespace, not a forged environment flag', () => {
            expect(inVpnNamespace(namespace, env, () => 22)).toBe(true);
            expect(
                inVpnNamespace(namespace, env, (path) =>
                    path.startsWith('/run/') ? 33 : 22
                )
            ).toBe(false);
            expect(inVpnNamespace(namespace, env, () => 11)).toBe(false);
            expect(
                inVpnNamespace(
                    namespace,
                    { ...env, VOPONO_NS: 'unrelated' },
                    () => 22
                )
            ).toBe(false);
            expect(
                inVpnNamespace(namespace, { VOPONO_NS: owned }, () => 22)
            ).toBe(false);
            expect(
                inVpnNamespace(namespace, env, () => {
                    throw new Error('missing namespace');
                })
            ).toBe(false);
        });
        it('keeps command arguments literal through a real shell parse', () => {
            const values = [
                "a'b",
                '$(printf SHOULD_NOT_RUN)',
                '`printf SHOULD_NOT_RUN`',
                'a b',
                'line\nbreak',
                '--no-sandbox',
            ];
            const output = execFileSync(
                '/bin/sh',
                [
                    '-c',
                    quoteVpnCommand([
                        process.execPath,
                        '-e',
                        'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
                        '--',
                        ...values,
                    ]),
                ],
                { encoding: 'utf8' }
            );
            expect(JSON.parse(output)).toEqual(values);
        });
        it('pins the provider/protocol and never disables the helper kill switch', () => {
            const args = vpnLaunchArguments('canada', namespace, [
                '/opt/My Player/player',
                '--example',
            ]);
            expect(args).toEqual([
                'exec',
                '--provider',
                'nordvpn',
                '--protocol',
                'wireguard',
                '--server',
                'canada',
                '--custom-netns-name',
                namespace,
                '--json',
                "'/opt/My Player/player' '--example'",
            ]);
            expect(args).not.toContain('--no-killswitch');
            for (const bad of [
                '--no-killswitch',
                'foo;id',
                'a/b',
                '',
                'foo bar',
            ]) {
                expect(validVpnServer(bad)).toBe(false);
                expect(() => vpnLaunchArguments(bad, namespace, [])).toThrow();
            }
            expect(vpnNamespaceName('/different/profile')).not.toBe(namespace);
        });
    }
);
