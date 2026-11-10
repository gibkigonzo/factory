import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { describe, it } from 'node:test';
import { CHANGED_PIXELS, compose, decodePng, differs, encodePng } from './png.ts';
import type { Image } from './png.ts';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(kind: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(kind, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

/** PNG złożony ręcznie: typ koloru, głębia, przeplot i wiersze już po filtrze (pierwszy bajt to typ filtra). */
function rawPng(width: number, height: number, type: number, rows: Buffer[], extra: Buffer[] = [], depth = 8, interlace = 0): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = type;
  header[12] = interlace;
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), ...extra, chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Filtr w przód dla wiersza RGB (3 bajty na piksel), żeby sprawdzić odwracanie wszystkich filtrów w dekoderze. */
function filtered(filter: number, line: number[], previous: number[]): Buffer {
  const out = line.map((value, i) => {
    const left = i >= 3 ? line[i - 3]! : 0;
    const up = previous[i] ?? 0;
    const corner = i >= 3 ? (previous[i - 3] ?? 0) : 0;
    const predictor = [0, left, up, (left + up) >> 1, paeth(left, up, corner)][filter]!;
    return (value - predictor) & 0xff;
  });
  return Buffer.from([filter, ...out]);
}

const solid = (width: number, height: number, rgba: number[]): Image => {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return { width, height, data };
};

describe('PNG', () => {
  it('koduje i odczytuje RGBA bez strat', () => {
    const data = Buffer.from(Array.from({ length: 3 * 2 * 4 }, (_, i) => (i * 37) & 0xff));
    const image = { width: 3, height: 2, data };
    assert.deepEqual(decodePng(encodePng(image)), image);
  });

  it('odwraca wszystkie filtry wierszy w obrazie RGB', () => {
    const lines = [0, 1, 2, 3, 4].map((y) => Array.from({ length: 2 * 3 }, (_, i) => (y * 50 + i * 31) & 0xff));
    const rows = lines.map((line, y) => filtered(y, line, y > 0 ? lines[y - 1]! : []));
    const image = decodePng(rawPng(2, 5, 2, rows));
    const rgb = [...image.data].filter((_, i) => i % 4 !== 3);
    assert.deepEqual(rgb, lines.flat());
    assert.ok([...image.data].filter((_, i) => i % 4 === 3).every((a) => a === 255));
  });

  it('odczytuje odcienie szarości i paletę z przezroczystością', () => {
    assert.deepEqual([...decodePng(rawPng(1, 1, 0, [Buffer.from([0, 77])])).data], [77, 77, 77, 255]);
    assert.deepEqual([...decodePng(rawPng(1, 1, 4, [Buffer.from([0, 77, 10])])).data], [77, 77, 77, 10]);
    const palette = [chunk('PLTE', Buffer.from([1, 2, 3, 4, 5, 6])), chunk('tRNS', Buffer.from([255, 0]))];
    assert.deepEqual([...decodePng(rawPng(2, 1, 3, [Buffer.from([0, 1, 0])], palette)).data], [4, 5, 6, 0, 1, 2, 3, 255]);
  });

  it('odrzuca to, czego nie obsługuje, zamiast zgadywać', () => {
    assert.throws(() => decodePng(Buffer.from('GIF89a')), /to nie PNG/);
    assert.throws(() => decodePng(rawPng(1, 1, 2, [Buffer.from([0, 0, 0, 0, 0, 0, 0])], [], 16)), /nieobsługiwany PNG/);
    assert.throws(() => decodePng(rawPng(1, 1, 2, [Buffer.from([0, 0, 0, 0])], [], 8, 1)), /nieobsługiwany PNG/);
    assert.throws(() => decodePng(rawPng(100_000, 1_000, 2, [Buffer.from([0])])), /zły rozmiar PNG/);
    assert.throws(() => decodePng(rawPng(2, 2, 2, [Buffer.from([0, 1, 2, 3, 4, 5, 6])])), /niepełne dane PNG/);
  });

  it('zmiana wyglądu: inny rozmiar albo kilka wyraźnie innych pikseli; drobny szum wygładzania to nie zmiana', () => {
    const base = solid(10, 10, [200, 200, 200, 255]);
    const changed = (count: number, delta: number) => {
      const copy = { ...base, data: Buffer.from(base.data) };
      for (let i = 0; i < count; i++) copy.data[i * 4] = 200 - delta;
      return encodePng(copy);
    };
    assert.equal(differs(encodePng(base), encodePng(base)), false);
    assert.equal(differs(encodePng(base), changed(50, 10)), false, 'różnica w granicach tolerancji');
    assert.equal(differs(encodePng(base), changed(CHANGED_PIXELS - 1, 100)), false);
    assert.equal(differs(encodePng(base), changed(CHANGED_PIXELS, 100)), true);
    assert.equal(differs(encodePng(base), encodePng(solid(10, 11, [200, 200, 200, 255]))), true, 'inny rozmiar');
  });

  it('składa wzorzec i wykonanie obok siebie albo jeden nad drugim, z paskiem pomiędzy', () => {
    const left = solid(2, 3, [1, 1, 1, 255]);
    const right = solid(4, 1, [2, 2, 2, 255]);
    const side = compose(left, right);
    assert.deepEqual([side.width, side.height], [2 + 12 + 4, 3]);
    assert.deepEqual([...side.data.subarray(0, 4)], [1, 1, 1, 255]);
    assert.deepEqual([...side.data.subarray(2 * 4, 3 * 4)], [0xd0, 0x1f, 0x6f, 0xff], 'pasek');
    assert.deepEqual([...side.data.subarray(14 * 4, 15 * 4)], [2, 2, 2, 255]);
    assert.deepEqual([...side.data.subarray((side.width + 14) * 4, (side.width + 15) * 4)], [255, 255, 255, 255], 'tło pod krótszym obrazem');
    const wide = compose(solid(1000, 1, [1, 1, 1, 255]), solid(1000, 2, [2, 2, 2, 255]));
    assert.deepEqual([wide.width, wide.height], [1000, 1 + 12 + 2], 'za szerokie obok siebie: jeden nad drugim');
  });
});
