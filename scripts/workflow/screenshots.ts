// Zrzuty ekranu z komendy `evidence.screenshots` w factory.yml. Komenda projektu zapisuje pliki PNG w katalogu
// ze zmiennej FACTORY_SCREENSHOTS: `<nazwa>@<szerokość>.png` to wykonanie po zmianie, a `<nazwa>@<szerokość>.ref.png`
// to wzorzec tej samej sekcji przy tej samej szerokości. Taśma podaje pary recenzentom i pokazuje je w PR.
// Pliki powstają z kodu PR, więc każdy job, który ich używa, sprawdza je od nowa: tylko zwykłe pliki PNG
// o dozwolonej nazwie, w limicie liczby i rozmiaru. Resztę usuwa z katalogu.

import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const SCREENSHOT_NAME = /^([a-z0-9][a-z0-9_-]{0,63})(?:@(\d{2,5}))?(\.ref)?\.png$/;
export const MAX_FILES = 60;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
/** Wynik komendy zapisany obok zrzutów. Pliki zrzutów i tak są sprawdzane od nowa. */
export const INDEX = 'index.json';
export const SCREENSHOTS_MARKER = '<!-- factory:screenshots -->';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface Shot {
  name: string;
  width?: number;
  /** Wykonanie po zmianie. */
  actual?: string;
  /** Wzorzec. */
  reference?: string;
}

export interface Collected {
  shots: Shot[];
  rejected: { file: string; reason: string }[];
}

function isPng(path: string): boolean {
  const head = Buffer.alloc(PNG.length);
  const fd = openSync(path, 'r');
  try {
    return readSync(fd, head, 0, head.length, 0) === head.length && head.equals(PNG);
  } finally {
    closeSync(fd);
  }
}

/** Sprawdza pliki w katalogu zrzutów i łączy je w pary. Z `prune` usuwa pliki odrzucone. */
export function collectScreenshots(dir: string, prune = true): Collected {
  if (!existsSync(dir)) return { shots: [], rejected: [] };
  const rejected: Collected['rejected'] = [];
  const accepted: string[] = [];
  let total = 0;
  for (const file of readdirSync(dir).filter((f) => f !== INDEX).sort()) {
    const path = join(dir, file);
    const stat = lstatSync(path);
    const reason = !stat.isFile()
      ? 'nie jest zwykłym plikiem'
      : !SCREENSHOT_NAME.test(file)
        ? 'nazwa poza wzorcem <nazwa>@<szerokość>.png albo <nazwa>@<szerokość>.ref.png'
        : stat.size > MAX_FILE_BYTES
          ? `ponad ${MAX_FILE_BYTES / 1024 / 1024} MB`
          : !isPng(path)
            ? 'to nie PNG'
            : accepted.length >= MAX_FILES || total + stat.size > MAX_TOTAL_BYTES
              ? `ponad limit ${MAX_FILES} plików albo ${MAX_TOTAL_BYTES / 1024 / 1024} MB razem`
              : undefined;
    if (reason) {
      rejected.push({ file, reason });
      if (prune) rmSync(path, { recursive: true, force: true });
    } else {
      accepted.push(file);
      total += stat.size;
    }
  }
  const shots = new Map<string, Shot>();
  for (const file of accepted) {
    const [, name, width, ref] = SCREENSHOT_NAME.exec(file)!;
    const key = `${name}@${width ?? ''}`;
    const shot = shots.get(key) ?? { name: name!, ...(width ? { width: Number(width) } : {}) };
    if (ref) shot.reference = file;
    else shot.actual = file;
    shots.set(key, shot);
  }
  const ordered = [...shots.values()].sort((a, b) => a.name.localeCompare(b.name) || (a.width ?? 0) - (b.width ?? 0));
  return { shots: ordered, rejected };
}

/** Czy komenda zrzutów zakończyła się sukcesem, według pliku INDEX; brak pliku albo zły format: nie wiadomo. */
export function screenshotsOk(dir: string): boolean | undefined {
  try {
    const ok = (JSON.parse(readFileSync(join(dir, INDEX), 'utf8')) as { ok?: unknown }).ok;
    return typeof ok === 'boolean' ? ok : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Uruchamia komendę zrzutów w katalogu repo. Wyjście komendy idzie do stderr (log joba), a wynik do pliku INDEX.
 * Czerwona komenda nie przerywa taśmy: recenzent i galeria mówią, że zrzutów może brakować.
 */
export function runScreenshots(command: string, dir: string, cwd: string, timeoutMs = 10 * 60 * 1000): Collected & { ok: boolean } {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const run = spawnSync('bash', ['-c', command], {
    cwd,
    stdio: ['ignore', 2, 2],
    timeout: timeoutMs,
    env: { ...process.env, FACTORY_SCREENSHOTS: resolve(dir) },
  });
  const result = { ok: run.status === 0, ...collectScreenshots(dir) };
  writeFileSync(join(dir, INDEX), JSON.stringify(result, null, 2));
  return result;
}

function label(shot: Shot): string {
  return shot.width ? `${shot.name}, ${shot.width} px` : shot.name;
}

/** Linia zadania recenzenta ze spisem zrzutów. Brak katalogu: projekt nie ma komendy zrzutów. */
export function screenshotsTask(dir: string): string[] {
  const { shots } = collectScreenshots(dir, false);
  // Bez pliku INDEX komenda zrzutów nie działała, np. projekt jej nie ma, a pobranie artefaktu dało pusty katalog.
  if (shots.length === 0 && !existsSync(join(dir, INDEX))) return [];
  const ok = screenshotsOk(dir);
  if (shots.length === 0) {
    return [`Komenda zrzutów z \`evidence.screenshots\` ${ok === false ? 'zakończyła się błędem i ' : ''}nie zostawiła żadnego zrzutu.`];
  }
  const path = (file?: string) => (file ? `\`${dir}/${file}\`` : 'brak');
  const list = shots.map((s) => `  - ${label(s)}: wykonanie ${path(s.actual)}, wzorzec ${path(s.reference)}`);
  const failed = ok === false ? ' Komenda zrzutów zakończyła się błędem, więc części zrzutów może brakować.' : '';
  return [`Zrzuty ekranu z CI, które otwierasz narzędziem Read (wykonanie po zmianie i wzorzec tej samej sekcji przy tej samej szerokości).${failed}\n${list.join('\n')}`];
}

export interface GalleryOptions {
  /** Adres pliku zrzutu w PR, np. na gałęzi z obrazami. */
  url: (file: string) => string;
  sha: string;
  ok?: boolean;
  runUrl?: string;
}

/** Komentarz w PR z parami wzorzec–wykonanie, żeby właściciel porównał je sam, także z telefonu. */
export function galleryComment(collected: Collected, options: GalleryOptions): string {
  const { shots, rejected } = collected;
  const lines = [SCREENSHOTS_MARKER, '### Zrzuty ekranu', ''];
  const log = options.runUrl ? ` Log: [przebieg](${options.runUrl}).` : '';
  if (options.ok === false) lines.push(`⚠️ Komenda zrzutów zakończyła się błędem, więc części zrzutów może brakować.${log}`, '');
  if (shots.length === 0) {
    lines.push('Komenda zrzutów nie zostawiła żadnego zrzutu.');
  } else {
    const withReference = shots.some((s) => s.reference);
    const image = (file?: string) => {
      if (!file) return '—';
      const url = options.url(file);
      return `<a href="${url}"><img src="${url}" width="220" alt="${file}"></a>`;
    };
    lines.push(
      `Commit \`${options.sha.slice(0, 7)}\`. ${withReference ? 'Wzorzec obok wykonania przy tej samej szerokości. ' : ''}Kliknięty obraz otwiera się w pełnym rozmiarze.`,
      '',
      withReference ? '| Zrzut | Wzorzec | Wykonanie |' : '| Zrzut | Wykonanie |',
      withReference ? '| --- | --- | --- |' : '| --- | --- |',
      ...shots.map((s) =>
        withReference ? `| ${label(s)} | ${image(s.reference)} | ${image(s.actual)} |` : `| ${label(s)} | ${image(s.actual)} |`,
      ),
    );
  }
  if (rejected.length) {
    // Nazwy plików pochodzą z kodu PR: w komentarzu tylko bezpieczne znaki.
    const safe = (file: string) => file.replace(/[^A-Za-z0-9._@-]/g, '?').slice(0, 80);
    const shown = rejected.slice(0, 10).map((r) => `\`${safe(r.file)}\` (${r.reason})`);
    const more = rejected.length > shown.length ? ` i ${rejected.length - shown.length} więcej` : '';
    lines.push('', `Pominięte pliki: ${shown.join(', ')}${more}.`);
  }
  return lines.join('\n');
}
