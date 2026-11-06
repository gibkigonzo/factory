// Dopasowanie ścieżek do wzorców z factory.yml.
// `*` i `?` nie przechodzą przez „/”, `**` jako cały segment to dowolna liczba katalogów (także zero).
// Wzorzec jest względny od korzenia repo: „factory.yml” pasuje tylko do pliku w korzeniu.

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached) return cached;
  const segments = glob.split('/');
  const source = segments
    .map((segment, index) => {
      const last = index === segments.length - 1;
      if (segment === '**') return last ? '.+' : '(?:[^/]+/)*';
      return segmentToRegExp(segment) + (last ? '' : '/');
    })
    .join('');
  const regexp = new RegExp(`^${source}$`);
  cache.set(glob, regexp);
  return regexp;
}

function segmentToRegExp(segment: string): string {
  return [...segment]
    .map((char) => {
      if (char === '*') return '[^/]*';
      if (char === '?') return '[^/]';
      return char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
}

export function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(path);
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => matchesGlob(path, glob));
}
