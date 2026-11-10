import { describe, expect, it } from 'vitest';
import { assertPublicEndpoint, isBlockedAddress } from './netguard.js';

const pub = async () => [{ address: '93.184.216.34', family: 4 }];
const guard = (url: string, lookup = pub, allowPrivate = false) => assertPublicEndpoint(url, { allowPrivate, lookup });

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '100.127.255.255', '169.254.169.254',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '::', '::1', 'fe80::1', 'febf::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.1.2.3', '::ffff:a9fe:a9fe', '::ffff:c0a8:1', '64:ff9b::7f00:1', '2002:7f00:1::1',
  ])('blocks %s', (ip) => { expect(isBlockedAddress(ip)).toBe(true); });
  it.each(['93.184.216.34', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('assertPublicEndpoint', () => {
  it('accepts a public https host', async () => { await expect(guard('https://s3.eu-west-1.example.com/')).resolves.toBeInstanceOf(URL); });
  it('requires https for user-owned destinations, allows http when shared', async () => {
    await expect(guard('http://s3.example.com')).rejects.toThrow(/https/);
    await expect(guard('http://minio:9000', pub, true)).resolves.toBeDefined();
  });
  it('allows private addresses only for shared destinations', async () => {
    await expect(guard('http://10.0.0.7:9000')).rejects.toThrow();
    await expect(guard('https://10.0.0.7:9000')).rejects.toThrow(/not publicly routable/);
    await expect(guard('https://10.0.0.7:9000', pub, true)).resolves.toBeDefined();
  });
  it('rejects credentials and non-http(s) schemes, even for shared', async () => {
    await expect(guard('https://u:p@s3.example.com', pub, true)).rejects.toThrow(/credentials/);
    await expect(guard('javascript:alert(1)', pub, true)).rejects.toThrow();
    await expect(guard('ftp://example.com', pub, true)).rejects.toThrow();
  });
  it.each(['https://127.0.0.1', 'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://169.254.169.254/latest', 'https://2130706433', 'https://0x7f.1',
    'https://localhost', 'https://api', 'https://vpn:8000', 'https://foo.localhost', 'https://printer.local', 'https://[fd00::1]'])('rejects %s', async (u) => {
    await expect(guard(u)).rejects.toThrow('Endpoint host is not publicly routable');
  });
  it('rejects when ANY resolved address is private (and never leaks it)', async () => {
    const mixed = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.9.8.7', family: 4 }];
    const err = await guard('https://rebind.example.com', mixed).catch((e: Error) => e);
    expect((err as Error).message).toBe('Endpoint host is not publicly routable');
    expect((err as Error).message).not.toContain('10.9.8.7');
  });
  it('rejects unresolvable hosts with a generic message', async () => {
    const fail = async (): Promise<never[]> => { throw new Error('ENOTFOUND secret-internal-name'); };
    await expect(guard('https://nx.example.com', fail)).rejects.toThrow('Endpoint host could not be resolved');
  });
});
