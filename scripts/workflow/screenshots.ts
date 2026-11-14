// Zrzuty ekranu z komendy `evidence.screenshots` w factory.yml. Komenda projektu zapisuje pliki PNG w katalogu
// ze zmiennej FACTORY_SCREENSHOTS: `<nazwa>@<szerokość>.png` to wykonanie po zmianie, a `<nazwa>@<szerokość>.ref.png`
// to wzorzec tej samej sekcji przy tej samej szerokości. Taśma robi te same zrzuty na gałęzi bazowej, porównuje
// piksele i recenzentowi wyglądu podaje tylko sekcje zmienione przez PR; w PR pokazuje linki do par.
// Pliki powstają z kodu PR, więc każdy job, który ich używa, sprawdza je od nowa: tylko zwykłe pliki PNG
// o dozwolonej nazwie, w limicie liczby i rozmiaru. Resztę usuwa z katalogu.

import { spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compose, decodePng, differs, encodePng } from './png.ts';

export const SCREENSHOT_NAME = /^([a-z0-9][a-z0-9_-]{0,63})(?:@(\d{2,5}))?(\.ref)?\.png$/;
export const MAX_FILES = 400;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
/** Powód odrzucenia pliku ponad limit. Taki plik nie znaczy, że sekcji nie ma: zrzut po prostu się nie zmieścił. */
export const LIMIT_REASON = `ponad limit ${MAX_FILES} plików albo ${MAX_TOTAL_BYTES / 1024 / 1024} MB razem`;
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
              ? LIMIT_REASON
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

/**
 * Pliki odrzucone przy przebiegu komendy (zapisane w INDEX). Katalog po pobraniu artefaktu ma już tylko pliki przyjęte,
 * więc bez INDEX nie wiadomo, że część zrzutów się nie zmieściła.
 */
export function indexRejected(dir: string): Collected['rejected'] {
  try {
    const rejected = (JSON.parse(readFileSync(join(dir, INDEX), 'utf8')) as { rejected?: unknown }).rejected;
    if (!Array.isArray(rejected)) return [];
    return rejected.flatMap((r) =>
      r && typeof r === 'object' && typeof (r as { file?: unknown }).file === 'string' && typeof (r as { reason?: unknown }).reason === 'string'
        ? [{ file: (r as { file: string }).file, reason: (r as { reason: string }).reason }]
        : [],
    );
  } catch {
    return [];
  }
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
 * Uruchamia komendę zrzutów w katalogu `cwd`, z `setup` najpierw komendę setup projektu (np. zrzuty gałęzi bazowej
 * w osobnym katalogu roboczym). Wyjście komend idzie do stderr (log joba), a wynik do pliku INDEX.
 * Czerwona komenda nie przerywa taśmy: recenzent i galeria mówią, że zrzutów może brakować.
 */
export function runScreenshots(
  command: string,
  dir: string,
  cwd: string,
  options: { setup?: string; timeoutMs?: number } = {},
): Collected & { ok: boolean } {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const env = { ...process.env, FACTORY_SCREENSHOTS: resolve(dir) };
  const run = (cmd: string) =>
    spawnSync('bash', ['-c', cmd], { cwd, stdio: ['ignore', 2, 2], timeout: options.timeoutMs ?? 10 * 60 * 1000, env }).status === 0;
  const ok = (!options.setup || run(options.setup)) && run(command);
  const result = { ok, ...collectScreenshots(dir) };
  writeFileSync(join(dir, INDEX), JSON.stringify(result, null, 2));
  return result;
}

/**
 * Zmiana wyglądu względem gałęzi bazowej: nowa sekcja, zmieniona, bez zmian, sekcja, która zniknęła,
 * albo zrzut po zmianie pominięty przez limit plików (sekcja może istnieć, ale nie ma czego porównać).
 */
export type Change = 'new' | 'changed' | 'unchanged' | 'removed' | 'skipped';

export interface Compared extends Collected {
  shots: (Shot & { change?: Change })[];
  /** Wynik komendy zrzutów po zmianie (INDEX). */
  ok?: boolean;
  /** Czy porównanie z gałęzią bazową się udało; bez niego `change` jest puste. */
  base: boolean;
}

const shotKey = (s: Shot) => `${s.name}@${s.width ?? ''}`;
const actualFile = (s: Shot) => `${s.name}${s.width ? `@${s.width}` : ''}.png`;
/** Odrzucone pliki z przebiegu (INDEX) i z ponownego sprawdzenia katalogu, bez powtórzeń. */
function allRejected(dir: string, collected: Collected): Collected['rejected'] {
  const seen = new Set<string>();
  return [...indexRejected(dir), ...collected.rejected].filter((r) => !seen.has(r.file) && seen.add(r.file));
}
const overLimit = (rejected: Collected['rejected']) => new Set(rejected.filter((r) => r.reason === LIMIT_REASON).map((r) => r.file));
const byNameAndWidth = (a: Shot, b: Shot) => a.name.localeCompare(b.name) || (a.width ?? 0) - (b.width ?? 0);

/** Czy zrzut wymaga oceny: zmienił się albo porównanie było niemożliwe. */
export const needsReview = (shot: Compared['shots'][number]) => shot.change !== 'unchanged';

/**
 * Zrzuty po zmianie ocenione względem zrzutów gałęzi bazowej (te same komendy na punkcie rozgałęzienia).
 * Decyduje porównanie pikseli, nie model. Gdy któraś komenda zrzutów nie przeszła, porównania nie ma.
 */
export function compareScreenshots(dir: string, baseDir?: string, prune = true): Compared {
  const collected = collectScreenshots(dir, prune);
  const head = { ...collected, rejected: allRejected(dir, collected) };
  const ok = screenshotsOk(dir);
  if (!baseDir || ok !== true || screenshotsOk(baseDir) !== true) return { ...head, ok, base: false };
  const before = collectScreenshots(baseDir, prune);
  const skippedHead = overLimit(head.rejected);
  const skippedBase = overLimit(allRejected(baseDir, before));
  const previous = new Map(before.shots.filter((s) => s.actual).map((s) => [shotKey(s), s.actual!]));
  const shots: Compared['shots'] = head.shots.map((shot) => {
    const old = previous.get(shotKey(shot));
    if (!shot.actual) return { ...shot, change: skippedHead.has(actualFile(shot)) ? 'skipped' : old ? 'removed' : 'unchanged' };
    // Bez zrzutu bazy (pominięty przez limit) nie ma z czym porównać: oceni recenzent.
    if (!old) return { ...shot, change: skippedBase.has(actualFile(shot)) ? 'changed' : 'new' };
    let changed = true;
    try {
      changed = differs(readFileSync(join(dir, shot.actual)), readFileSync(join(baseDir, old)));
    } catch {
      // Obraz, którego nie da się odczytać, traktujemy jak zmieniony: niech oceni go recenzent.
    }
    return { ...shot, change: changed ? 'changed' : 'unchanged' };
  });
  const present = new Set(head.shots.map(shotKey));
  for (const shot of before.shots) {
    if (shot.actual && !present.has(shotKey(shot))) {
      shots.push({ name: shot.name, ...(shot.width ? { width: shot.width } : {}), change: skippedHead.has(actualFile(shot)) ? 'skipped' : 'removed' });
    }
  }
  return { shots: shots.sort(byNameAndWidth), rejected: head.rejected, ok, base: true };
}

function label(shot: Shot): string {
  return shot.width ? `${shot.name}, ${shot.width} px` : shot.name;
}

function plural(n: number, one: string, few: string, many: string): string {
  const tens = n % 100;
  const units = n % 10;
  return `${n} ${n === 1 ? one : units >= 2 && units <= 4 && (tens < 12 || tens > 14) ? few : many}`;
}

/**
 * Linia zadania recenzenta, który ocenia wygląd: tylko zrzuty sekcji zmienionych względem gałęzi bazowej.
 * Bez porównania (np. pierwsza wersja komendy zrzutów) spis obejmuje wszystkie zrzuty.
 * Brak katalogu: projekt nie ma komendy zrzutów albo perspektywa ich nie używa.
 */
export function screenshotsTask(dir: string, baseDir?: string): string[] {
  const compared = compareScreenshots(dir, baseDir, false);
  // Bez pliku INDEX komenda zrzutów nie działała, np. projekt jej nie ma, a pobranie artefaktu dało pusty katalog.
  if (compared.shots.length === 0 && !existsSync(join(dir, INDEX))) return [];
  if (compared.shots.length === 0) {
    return [`Komenda zrzutów z \`evidence.screenshots\` ${compared.ok === false ? 'zakończyła się błędem i ' : ''}nie zostawiła żadnego zrzutu.`];
  }
  const path = (file?: string) => (file ? `\`${dir}/${file}\`` : 'brak');
  const describe = (s: Compared['shots'][number]) =>
    s.change === 'removed'
      ? `  - ${label(s)}: sekcja była przed zmianą, a po zmianie jej nie ma; wzorzec ${path(s.reference)}`
      : s.change === 'skipped'
        ? `  - ${label(s)}: zrzut po zmianie pominięty przez limit plików; nie znaczy to, że sekcji nie ma, a tej szerokości nie oceniasz`
        : `  - ${label(s)}${s.change === 'new' ? ' (nowa)' : ''}: wykonanie ${path(s.actual)}, wzorzec ${path(s.reference)}`;
  const intro = 'Zrzuty ekranu z CI otwierasz narzędziem Read: wykonanie po zmianie i wzorzec tej samej sekcji przy tej samej szerokości.';
  if (!compared.base) {
    const failed = compared.ok === false ? ' Komenda zrzutów zakończyła się błędem, więc części zrzutów może brakować.' : '';
    return [`${intro} Porównanie z gałęzią główną się nie udało, więc nie wiadomo, które sekcje zmieniła zmiana.${failed}\n${compared.shots.map(describe).join('\n')}`];
  }
  const changed = compared.shots.filter(needsReview);
  const same = compared.shots.length - changed.length;
  if (changed.length === 0) return [`Wszystkie zrzuty z CI (${compared.shots.length}) są identyczne jak na gałęzi głównej: zmiana nie zmienia wyglądu.`];
  return [
    `${intro} Poniżej tylko sekcje, których wygląd zmienił się względem gałęzi głównej (skrypt porównał zrzuty przed i po zmianie). ${plural(same, 'zrzut jest identyczny', 'zrzuty są identyczne', 'zrzutów jest identycznych')} jak przed zmianą i ich nie oceniasz.\n${changed.map(describe).join('\n')}`,
  ];
}

/**
 * Werdykt bez modelu dla perspektywy wyglądu, gdy porównanie z gałęzią bazową się udało, a żaden zrzut się nie zmienił.
 * Wtedy nie ma czego oceniać, więc sesja Claude byłaby tylko kosztem.
 */
export function unchangedVerdict(dir: string, baseDir: string, perspective: string) {
  const compared = compareScreenshots(dir, baseDir, false);
  if (!compared.base || compared.shots.length === 0 || compared.shots.some(needsReview)) return undefined;
  return {
    perspective,
    verdict: 'approve' as const,
    confidence: 0.95,
    summary: `Wszystkie zrzuty (${compared.shots.length}) są identyczne jak na gałęzi głównej, więc zmiana nie zmienia wyglądu. Werdykt wystawił skrypt porównujący zrzuty, bez modelu.`,
    findings: [],
    risk_signals: [],
  };
}

const CHANGE_WORD: Record<string, string> = { changed: 'zmieniony', new: 'nowy', removed: 'usunięty', skipped: 'pominięty przez limit' };

/**
 * Streszczenie porównania zrzutów z gałęzią bazową dla wszystkich recenzentów (plik visual.md), nie tylko dla
 * perspektywy wyglądu. To dowód dla kryterium „wygląd bez zmian”: lekcja z pilota, recenzent specu go nie znał
 * i zażądał testu, a implementer dopisał wzorce zrzutów całej strony, które psuły każdą późniejszą zmianę wyglądu.
 */
export function visualSummary(dir: string, baseDir?: string): string {
  const compared = compareScreenshots(dir, baseDir, false);
  if (compared.shots.length === 0) return 'Porównania zrzutów nie ma: komenda zrzutów nie zostawiła żadnego zrzutu.';
  const total = compared.shots.length;
  if (!compared.base) {
    return `Porównania zrzutów z gałęzią główną nie ma (komenda zrzutów zakończyła się błędem albo brak zrzutów bazy), więc nie wiadomo, czy wygląd się zmienił. Zrzutów po zmianie: ${total}.`;
  }
  const changed = compared.shots.filter(needsReview);
  if (changed.length === 0) {
    return `Porównanie zrzutów taśmy: wszystkie zrzuty (${total}) są identyczne piksel w piksel jak na gałęzi głównej, więc zmiana nie zmienia wyglądu.`;
  }
  return [
    `Porównanie zrzutów taśmy: ${changed.length} z ${total} zrzutów różni się od gałęzi głównej, reszta jest identyczna piksel w piksel.`,
    ...changed.map((s) => `- ${label(s)}: ${CHANGE_WORD[s.change ?? 'changed'] ?? s.change}`),
  ].join('\n');
}

/**
 * Pliki galerii w `out`: dla pary jeden obraz z wzorcem po lewej albo u góry i wykonaniem obok albo pod spodem,
 * dla pojedynczego zrzutu sam zrzut. Zwraca nazwę opublikowanego pliku dla każdego zrzutu.
 */
export function writeGallery(compared: Compared, dir: string, out: string): Map<string, string> {
  mkdirSync(out, { recursive: true });
  const files = new Map<string, string>();
  for (const shot of compared.shots) {
    if (shot.actual && shot.reference) {
      try {
        const image = compose(decodePng(readFileSync(join(dir, shot.reference))), decodePng(readFileSync(join(dir, shot.actual))));
        writeFileSync(join(out, shot.actual), encodePng(image));
        files.set(shotKey(shot), shot.actual);
        continue;
      } catch {
        // Nieobsługiwany PNG: w galerii zostaje samo wykonanie.
      }
    }
    const single = shot.actual ?? shot.reference;
    if (!single) continue;
    copyFileSync(join(dir, single), join(out, single));
    files.set(shotKey(shot), single);
  }
  return files;
}

export interface GalleryOptions {
  /** Adres pliku galerii, np. na gałęzi z obrazami. */
  url: (file: string) => string;
  sha: string;
  runUrl?: string;
  /** Runda poprawek; od 1 w nagłówku, tak jak w werdykcie trybu cienia. */
  round?: number;
}

/**
 * Komentarz w PR z linkami do par wzorzec–wykonanie. Linki zamiast obrazów w treści, bo GitHub pokazuje obrazy
 * z komentarzy przez swój serwer pośredni, a ten nie widzi plików repo prywatnego. Link otwiera się zalogowanym.
 * Najpierw sekcje zmienione względem gałęzi bazowej; reszta jest zwinięta.
 */
export function galleryComment(compared: Compared, files: Map<string, string>, options: GalleryOptions): string {
  const lines = [SCREENSHOTS_MARKER, `### Zrzuty ekranu${options.round ? ` · runda ${options.round}` : ''}`, ''];
  const log = options.runUrl ? ` Log: [przebieg](${options.runUrl}).` : '';
  if (compared.ok === false) lines.push(`⚠️ Komenda zrzutów zakończyła się błędem, więc części zrzutów może brakować.${log}`, '');
  const link = (shot: Compared['shots'][number]) => {
    const width = shot.width ? `${shot.width} px` : 'obraz';
    if (shot.change === 'removed') return `${width}: sekcji już nie ma`;
    if (shot.change === 'skipped') return `${width}: zrzut pominięty (limit plików)`;
    const file = files.get(shotKey(shot));
    if (!file) return width;
    const only = !shot.actual ? ' (tylko wzorzec)' : !shot.reference ? ' (tylko wykonanie)' : '';
    return `[${width}](${options.url(file)})${only}${shot.change === 'new' ? ' (nowa)' : ''}`;
  };
  const list = (shots: Compared['shots']) => {
    const names = [...new Set(shots.map((s) => s.name))];
    return names.map((name) => `- ${name}: ${shots.filter((s) => s.name === name).map(link).join(' · ')}`);
  };
  if (compared.shots.length === 0) {
    lines.push('Komenda zrzutów nie zostawiła żadnego zrzutu.');
  } else {
    const pairs = compared.shots.some((s) => s.actual && s.reference);
    lines.push(`Commit \`${options.sha.slice(0, 7)}\`.${pairs ? ' Link otwiera wzorzec po lewej albo u góry, a wykonanie obok albo pod spodem.' : ''}`, '');
    // Sam wzorzec bez wykonania: sekcji jeszcze nie ma na stronie. Osobny zwinięty blok, żeby nie zasłaniał zmian.
    const pending = compared.shots.filter((s) => !s.actual && s.change !== 'removed' && s.change !== 'new' && s.change !== 'skipped');
    const rest = compared.shots.filter((s) => !pending.includes(s));
    if (!compared.base) {
      lines.push('Porównanie z gałęzią główną się nie udało, więc lista obejmuje wszystkie zrzuty.', '', ...list(rest));
    } else {
      const changed = rest.filter(needsReview);
      const same = rest.filter((s) => !needsReview(s));
      if (changed.length) lines.push(`**Zmienione względem gałęzi głównej (${changed.length}):**`, '', ...list(changed));
      else lines.push('**Wygląd bez zmian względem gałęzi głównej.**');
      if (same.length) {
        lines.push('', `<details><summary>Bez zmian: ${plural(same.length, 'zrzut', 'zrzuty', 'zrzutów')}</summary>`, '', ...list(same), '', '</details>');
      }
    }
    if (pending.length) {
      lines.push('', `<details><summary>Sekcji jeszcze nie ma na stronie (sam wzorzec): ${pending.length}</summary>`, '', ...list(pending), '', '</details>');
    }
  }
  if (compared.rejected.length) {
    // Nazwy plików pochodzą z kodu PR: w komentarzu tylko bezpieczne znaki.
    const safe = (file: string) => file.replace(/[^A-Za-z0-9._@-]/g, '?').slice(0, 80);
    const shown = compared.rejected.slice(0, 10).map((r) => `\`${safe(r.file)}\` (${r.reason})`);
    const more = compared.rejected.length > shown.length ? ` i ${compared.rejected.length - shown.length} więcej` : '';
    lines.push('', `Pominięte pliki: ${shown.join(', ')}${more}.`);
  }
  return lines.join('\n');
}
