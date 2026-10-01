import geoip from 'fast-geoip'

/**
 * Roughly where a request came from, as a place a person recognises:
 * "San Pablo City, Philippines", or just "Philippines" when the city is unknown.
 *
 * Used only to tell an account holder where their password was changed from,
 * instead of showing them a bare IP address. The lookup is OFFLINE (the
 * fast-geoip database ships inside the package), so the address never leaves
 * this process: no third-party geolocation service ever sees it. Neither the
 * IP nor the result is stored or logged. Company policy is that a user's IP is
 * not recorded, and this keeps to that.
 *
 * Returns null whenever there is nothing honest to say: loopback or private
 * addresses (local development, an internal hop), IPv6 (the database is IPv4
 * only), or an address the database does not know. The caller leaves the line
 * out in that case, rather than printing a guess.
 */
export async function describeIpLocation(ip?: string | null): Promise<string | null> {
  if (!ip) return null
  // Express reports IPv4 through an IPv6 stack as ::ffff:1.2.3.4
  const bare = ip.trim().replace(/^::ffff:/i, '')
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || isPrivateIpv4(bare)) return null

  try {
    const info = await geoip.lookup(bare)
    if (!info?.country) return null
    const country = countryName(info.country)
    return info.city ? `${info.city}, ${country}` : country
  } catch {
    // A failed lookup only costs the email one line; it must never fail the reset.
    return null
  }
}

function isPrivateIpv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number)
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)   // carrier-grade NAT
  )
}

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}
