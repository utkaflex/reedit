import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
const crc = (data: Uint8Array) => {
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const name = Buffer.from(type),
    size = Buffer.alloc(4),
    sum = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  sum.writeUInt32BE(crc(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, sum]);
};
// Original geometric open-book mark. Supersampling smooths the strokes without external assets.
for (const [name, size] of [
  ['icon-192', 192],
  ['icon-512', 512],
  ['apple-touch-icon', 180],
  ['maskable-512', 512],
] as const) {
  const data = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let ink = 0;
      for (let dy = 0; dy < 3; dy++)
        for (let dx = 0; dx < 3; dx++) {
          const px = ((x + (dx + 0.5) / 3) / size) * 512,
            py = ((y + (dy + 0.5) / 3) / size) * 512;
          const edge = px < 256 ? px - 132 : 380 - px;
          const curve = 144 + 26 * (edge / 124) ** 2;
          if (
            ((Math.abs(px - 132) < 8 || Math.abs(px - 380) < 8) &&
              py >= 144 &&
              py <= 354) ||
            (Math.abs(px - 256) < 8 && py >= 170 && py <= 380) ||
            (px >= 132 &&
              px <= 380 &&
              (Math.abs(py - curve) < 8 || Math.abs(py - (curve + 210)) < 8))
          )
            ink++;
        }
      const offset = y * (size * 3 + 1) + 1 + x * 3;
      for (let channel = 0; channel < 3; channel++)
        data[offset + channel] = Math.round(
          ([57, 92, 69][channel] ?? 0) * (1 - ink / 9) +
            (([255, 254, 250][channel] ?? 0) * ink) / 9,
        );
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  writeFileSync(
    `public/icons/${name}.png`,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(data)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}
