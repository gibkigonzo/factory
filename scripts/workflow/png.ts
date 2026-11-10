// Minimalny dekoder i koder PNG (8 bitów na kanał, bez przeplotu), bez zależności: porównanie zrzutów przed i po
// zmianie oraz obraz „wzorzec obok wykonania” dla galerii w PR. Zrzuty z przeglądarek mają właśnie taki format;
// inny format kończy się błędem, a wywołujący traktuje zrzut jak zmieniony.

import { crc32, deflateSync, inflateSync } from 'node:zlib';

export interface Image {
  width: number;
  height: number;
  /** Piksele RGBA, wiersz po wierszu. */
  data: Buffer;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
/** Ochrona przed obrazem, który po rozpakowaniu zająłby za dużo pamięci. */
const MAX_PIXELS = 60_000_000;

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(buffer: Buffer): Image {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('to nie PNG');
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = -1;
  let interlace = 0;
  let palette: Buffer | undefined;
  let alpha: Buffer | undefined;
  const chunks: Buffer[] = [];
  for (let pos = 8; pos + 8 <= buffer.length; ) {
    const length = buffer.readUInt32BE(pos);
    const kind = buffer.toString('latin1', pos + 4, pos + 8);
    const body = buffer.subarray(pos + 8, pos + 8 + length);
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8]!;
      type = body[9]!;
      interlace = body[12]!;
    } else if (kind === 'PLTE') palette = body;
    else if (kind === 'tRNS') alpha = body;
    else if (kind === 'IDAT') chunks.push(body);
    else if (kind === 'IEND') break;
    pos += 12 + length;
  }
  const channels = CHANNELS[type];
  if (!channels || depth !== 8 || interlace !== 0) throw new Error(`nieobsługiwany PNG: typ ${type}, ${depth} bitów, przeplot ${interlace}`);
  if (width === 0 || height === 0 || width * height > MAX_PIXELS) throw new Error(`zły rozmiar PNG: ${width}×${height}`);
  if (type === 3 && !palette) throw new Error('PNG z paletą bez PLTE');
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: height * (stride + 1) });
  if (raw.length !== height * (stride + 1)) throw new Error('niepełne dane PNG');

  const data = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? line[i - channels]! : 0;
      const up = previous[i]!;
      const corner = i >= channels ? previous[i - channels]! : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : filter === 4 ? paeth(left, up, corner) : -1;
      if (predictor < 0) throw new Error(`zły filtr PNG: ${filter}`);
      line[i] = (line[i]! + predictor) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      const at = x * channels;
      if (type === 3) {
        const index = line[at]!;
        data[out] = palette![index * 3] ?? 0;
        data[out + 1] = palette![index * 3 + 1] ?? 0;
        data[out + 2] = palette![index * 3 + 2] ?? 0;
        data[out + 3] = alpha?.[index] ?? 255;
      } else if (type === 0 || type === 4) {
        data[out] = data[out + 1] = data[out + 2] = line[at]!;
        data[out + 3] = type === 4 ? line[at + 1]! : 255;
      } else {
        data[out] = line[at]!;
        data[out + 1] = line[at + 1]!;
        data[out + 2] = line[at + 2]!;
        data[out + 3] = type === 6 ? line[at + 3]! : 255;
      }
    }
    previous = line;
  }
  return { width, height, data };
}

function chunk(kind: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(kind, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

/** PNG RGBA; każdy wiersz z filtrem „Up”, który dobrze pakuje zrzuty ekranu. */
export function encodePng(image: Image): Buffer {
  const stride = image.width * 4;
  const raw = Buffer.alloc(image.height * (stride + 1));
  for (let y = 0; y < image.height; y++) {
    const row = y * (stride + 1);
    raw[row] = y === 0 ? 0 : 2;
    for (let i = 0; i < stride; i++) {
      const value = image.data[y * stride + i]!;
      raw[row + 1 + i] = y === 0 ? value : (value - image.data[(y - 1) * stride + i]!) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Próg różnicy kanału, poniżej którego piksel uznajemy za ten sam (wygładzanie krawędzi). Wartość startowa. */
export const PIXEL_TOLERANCE = 16;
/** Ile pikseli ponad progiem oznacza zmianę wyglądu. Wartość startowa. */
export const CHANGED_PIXELS = 3;

/** Czy dwa zrzuty różnią się widocznie: inny rozmiar albo co najmniej CHANGED_PIXELS wyraźnie innych pikseli. */
export function differs(a: Buffer, b: Buffer): boolean {
  if (a.equals(b)) return false;
  const left = decodePng(a);
  const right = decodePng(b);
  if (left.width !== right.width || left.height !== right.height) return true;
  let count = 0;
  for (let i = 0; i < left.data.length; i += 4) {
    for (let c = 0; c < 4; c++) {
      if (Math.abs(left.data[i + c]! - right.data[i + c]!) > PIXEL_TOLERANCE) {
        if (++count >= CHANGED_PIXELS) return true;
        break;
      }
    }
  }
  return false;
}

const GAP = 12;
const SEPARATOR = [0xd0, 0x1f, 0x6f, 0xff];
const SIDE_BY_SIDE_MAX = 1600;

/**
 * Dwa obrazy w jednym: obok siebie, gdy razem mieszczą się w SIDE_BY_SIDE_MAX px szerokości, inaczej jeden nad drugim.
 * Między nimi pasek w wyraźnym kolorze, żeby było widać granicę.
 */
export function compose(first: Image, second: Image): Image {
  const sideBySide = first.width + GAP + second.width <= SIDE_BY_SIDE_MAX;
  const width = sideBySide ? first.width + GAP + second.width : Math.max(first.width, second.width);
  const height = sideBySide ? Math.max(first.height, second.height) : first.height + GAP + second.height;
  const data = Buffer.alloc(width * height * 4, 0xff);
  const paste = (image: Image, left: number, top: number) => {
    for (let y = 0; y < image.height; y++) {
      image.data.copy(data, ((top + y) * width + left) * 4, y * image.width * 4, (y + 1) * image.width * 4);
    }
  };
  const fill = (left: number, top: number, w: number, h: number) => {
    for (let y = top; y < top + h; y++) for (let x = left; x < left + w; x++) data.set(SEPARATOR, (y * width + x) * 4);
  };
  paste(first, 0, 0);
  if (sideBySide) {
    fill(first.width, 0, GAP, height);
    paste(second, first.width + GAP, 0);
  } else {
    fill(0, first.height, width, GAP);
    paste(second, 0, first.height + GAP);
  }
  return { width, height, data };
}
