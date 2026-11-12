import { getAddressUrl } from './addressInput.ts';

type AddressSource = { title: string; url?: string; children?: AddressSource[] };

export type AddressSuggestion = {
  title: string;
  value: string;
  kind: 'bookmark' | 'history' | 'search' | 'navigation';
};

export function getAddressSuggestions(
  input: string,
  bookmarks: AddressSource[],
  history: AddressSource[],
  pages: AddressSource[] = [],
): AddressSuggestion[] {
  const query = input.trim().toLowerCase();
  if (!query) return [];

  const urlKey = (url: string) => {
    try { return new URL(url).href; } catch { return url; }
  };
  const titles = new Map<string, string>();
  const collectTitles = (sources: AddressSource[]) => {
    for (const source of sources) {
      const url = source.url?.trim();
      const title = source.title.trim();
      if (url && title && title !== url && urlKey(title) !== urlKey(url) && !titles.has(urlKey(url))) {
        titles.set(urlKey(url), title);
      }
      if (source.children) collectTitles(source.children);
    }
  };
  // Look across visits before deduplicating, since the latest visit may still
  // have its URL as a placeholder while an older visit has the page title.
  collectTitles(bookmarks);
  collectTitles(pages);
  collectTitles(history);

  const matches: AddressSuggestion[] = [];
  const seen = new Set<string>();
  const collect = (sources: AddressSource[], kind: 'bookmark' | 'history') => {
    for (const source of sources) {
      const url = source.url?.trim();
      const title = url ? titles.get(urlKey(url)) || url : source.title;
      if (url && !seen.has(url) &&
          (url.toLowerCase().includes(query) || title.toLowerCase().includes(query))) {
        seen.add(url);
        matches.push({ title, value: url, kind });
      }
      if (source.children) collect(source.children, kind);
    }
  };
  collect(bookmarks, 'bookmark');
  collect(history, 'history');

  // Prefer addresses starting with the query; preserve source and recency order on ties.
  const startsWithQuery = (value: string) =>
    value.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').startsWith(query);
  matches.sort((a, b) => Number(startsWithQuery(b.value)) - Number(startsWithQuery(a.value)));
  const value = input.trim();
  const isAddress = getAddressUrl(value) !== null;
  return [
    ...matches.slice(0, 4),
    { title: `${isAddress ? 'Go to' : 'Search'} ${value}`, value, kind: isAddress ? 'navigation' : 'search' },
  ];
}
