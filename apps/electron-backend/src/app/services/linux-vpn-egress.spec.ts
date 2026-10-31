jest.mock('electron', () => ({ net: { fetch: jest.fn() } }));
import { net } from 'electron';

describe('Protected player public IP lookup', () => {
    beforeEach(() => {
        jest.resetModules();
        jest.mocked(net.fetch).mockReset();
    });
    afterEach(() => jest.restoreAllMocks());

    it('coalesces requests and caches only a validated public IP briefly', async () => {
        const { net: mockedNet } = await import('electron');
        jest.mocked(mockedNet.fetch).mockResolvedValue(
            new Response('{"ip":"203.0.113.7"}')
        );
        const { getVpnPublicIp } = await import('./linux-vpn-egress');
        expect(await Promise.all([getVpnPublicIp(), getVpnPublicIp()])).toEqual(
            ['203.0.113.7', '203.0.113.7']
        );
        expect(await getVpnPublicIp()).toBe('203.0.113.7');
        expect(mockedNet.fetch).toHaveBeenCalledTimes(1);
        expect(mockedNet.fetch).toHaveBeenCalledWith(
            'https://api.ipify.org?format=json',
            expect.objectContaining({ credentials: 'omit', cache: 'no-store' })
        );
    });

    it('rejects malformed addresses and retries after a short failure cache', async () => {
        let now = 1000;
        jest.spyOn(Date, 'now').mockImplementation(() => now);
        const { net: mockedNet } = await import('electron');
        jest.mocked(mockedNet.fetch)
            .mockResolvedValueOnce(new Response('{"ip":"<not an address>"}'))
            .mockResolvedValueOnce(new Response('{"ip":"203.0.113.8"}'));
        const { getVpnPublicIp } = await import('./linux-vpn-egress');
        expect(await getVpnPublicIp()).toBeUndefined();
        now += 5001;
        expect(await getVpnPublicIp()).toBe('203.0.113.8');
    });
});
