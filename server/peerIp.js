// Peer-IP resolution and proxy-chain trust. Extracted from server.js so the
// XFF chain-length rule is unit-testable (tests/peerIp.test.mjs). No I/O and
// no state: everything derives from the request and the configured hop count.
import net from 'node:net';

// Cloudflare-published IP ranges (https://www.cloudflare.com/ips/).
// Refresh manually when Cloudflare announces changes; the lists are stable
// for months at a time.
export const CLOUDFLARE_IPV4_RANGES = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];
export const CLOUDFLARE_IPV6_RANGES = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

export function buildCloudflareBlockList() {
  const blockList = new net.BlockList();
  for (const range of CLOUDFLARE_IPV4_RANGES) {
    const [addr, prefix] = range.split('/');
    blockList.addSubnet(addr, Number(prefix), 'ipv4');
  }
  for (const range of CLOUDFLARE_IPV6_RANGES) {
    const [addr, prefix] = range.split('/');
    blockList.addSubnet(addr, Number(prefix), 'ipv6');
  }
  return blockList;
}

// trustProxyHops is the number of trusted proxies in front of the service
// (Cloudflare edge + Cloud Run load balancer = 2 in production). Every trusted
// proxy APPENDS to X-Forwarded-For, so a chain shorter than the trusted hop
// count means a proxy was skipped or replaced the header — the rightmost entry
// is then attacker-controlled and must not be trusted.
export function createPeerIpResolver({
  trustProxyHops = 0,
  blockList = buildCloudflareBlockList()
} = {}) {
  function xffParts(req) {
    const xff = req.headers?.['x-forwarded-for'];
    if (typeof xff !== 'string' || xff.length === 0) return [];
    return xff.split(',').map(s => s.trim()).filter(Boolean);
  }

  function hasTrustedXffChain(req) {
    return xffParts(req).length >= trustProxyHops;
  }

  // Returns the IP of the immediate upstream peer. Only trusted when the XFF
  // chain carries at least `trustProxyHops` entries; otherwise fall back to
  // the socket address, which no header can spoof.
  function getImmediatePeerIp(req) {
    const parts = xffParts(req);
    if (parts.length > 0 && hasTrustedXffChain(req)) {
      return parts[parts.length - 1];
    }
    return req.socket?.remoteAddress || null;
  }

  function isFromCloudflare(req) {
    const ip = getImmediatePeerIp(req);
    if (!ip) return false;
    const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    if (net.isIPv4(normalized)) return blockList.check(normalized, 'ipv4');
    if (net.isIPv6(normalized)) return blockList.check(normalized, 'ipv6');
    return false;
  }

  // CF-Connecting-IP is set by Cloudflare and contains the original client IP.
  // Trust it only when the immediate peer is a Cloudflare edge AND the chain
  // length backs that up; otherwise fall back to Fastify's trusted-proxy IP
  // (trusted chains) or the socket address (untrusted chains).
  function getClientIp(req) {
    const cfIp = req.headers['cf-connecting-ip'];
    if (typeof cfIp === 'string' && cfIp.length > 0 && isFromCloudflare(req)) return cfIp;
    if (!hasTrustedXffChain(req)) {
      return req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
    }
    return req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
  }

  return {
    xffParts,
    hasTrustedXffChain,
    getImmediatePeerIp,
    isFromCloudflare,
    getClientIp
  };
}
