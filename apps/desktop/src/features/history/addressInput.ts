import { topLevelDomains } from './topLevelDomains.ts';

/** Parse and validate an address without making requests as the user types. */
export function getAddressUrl(input: string): string | null {
  const value = input.trim();
  if (!value || /[\s\\]/.test(value) ||
      Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;

  if (value.startsWith('view-source:')) {
    const inner = value.slice('view-source:'.length);
    if (!/^https?:\/\//i.test(inner)) return null;
    const address = getAddressUrl(inner);
    return address ? `view-source:${address}` : null;
  }

  const explicitScheme = /^(https?|file|about|mira|data):/i.test(value);
  let candidate = value;
  if (!explicitScheme) {
    // Bare IPv6 literals need brackets when used as URL hosts.
    if (/^[\da-f:]+$/i.test(value) && value.includes('::')) {
      candidate = `https://[${value}]`;
    } else {
      candidate = value.startsWith('//') ? `https:${value}` : `https://${value}`;
    }
  } else if (/^https?:/i.test(value) && !/^https?:\/\//i.test(value)) {
    // URL() repairs incomplete schemes such as "https:example.com".
    return null;
  }

  try {
    const url = new URL(candidate);
    if (url.protocol === 'about:') return url.pathname ? url.href : null;
    if (url.protocol === 'data:') return value.includes(',') ? url.href : null;
    if (url.protocol === 'file:') return url.pathname && /^file:\/\//i.test(value) ? url.href : null;
    if (url.protocol === 'mira:') return url.hostname && /^mira:\/\//i.test(value) ? url.href : null;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    // Reject missing hosts that URL() otherwise repairs, e.g. https:///example.com.
    const authority = candidate.match(/^https?:\/\/([^/?#]+)/i)?.[1];
    if (!authority || authority.includes('@')) return null;
    const host = url.hostname.toLowerCase();
    if (!host || (url.port && Number(url.port) === 0)) return null;

    // URL() validates IPv6 syntax and IPv4 octet ranges. Check the original
    // IPv4 spelling too, so shorthand, hex and octal aren't mistaken for IPs.
    if (host.startsWith('[')) return url.href;
    if (/^[\d.]+$/.test(host)) {
      const originalHost = authority.split(':')[0];
      const octets = originalHost.split('.');
      return octets.length === 4 && octets.every(part =>
        /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255,
      ) ? url.href : null;
    }
    if (host === 'localhost') return url.href;

    const domain = host.replace(/\.$/, '');
    const labels = domain.split('.');
    if (domain.length > 253 || labels.length < 2) return null;
    if (!labels.every(label =>
      label.length <= 63 && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/.test(label),
    )) return null;
    const tld = labels[labels.length - 1];
    return topLevelDomains.has(tld) ? url.href : null;
  } catch {
    return null;
  }
}
