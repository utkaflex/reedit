import { EpubImportError } from '../../domain/epub';
/** Inspect dimensions before the untrusted raster is ever passed to an image decoder. */
export function rasterCover(
  bytes: Uint8Array<ArrayBuffer>,
  media: string,
): Blob {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const invalid = (): never => {
    throw new EpubImportError(
      'resource',
      'Не удалось безопасно прочитать размеры встроенной обложки.',
    );
  };
  let width = 0;
  let height = 0;
  if (media === 'image/png' && bytes.length >= 24) {
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (media === 'image/jpeg') {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 255) return invalid();
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0xda || marker === 0xd9) break;
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) return invalid();
      const size = view.getUint16(offset);
      if (size < 2 || offset + size > bytes.length) return invalid();
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker)
      ) {
        if (size < 8) return invalid();
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
        break;
      }
      offset += size;
    }
  } else if (media === 'image/webp' && bytes.length >= 30) {
    const kind = new TextDecoder().decode(bytes.subarray(12, 16));
    const uint24 = (offset: number) =>
      (bytes[offset] ?? 0) +
      ((bytes[offset + 1] ?? 0) << 8) +
      ((bytes[offset + 2] ?? 0) << 16);
    if (kind === 'VP8X') {
      width = uint24(24) + 1;
      height = uint24(27) + 1;
    } else if (kind === 'VP8L' && bytes[20] === 47) {
      const bits = view.getUint32(21, true);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (
      kind === 'VP8 ' &&
      bytes[23] === 157 &&
      bytes[24] === 1 &&
      bytes[25] === 42
    ) {
      width = view.getUint16(26, true) & 0x3fff;
      height = view.getUint16(28, true) & 0x3fff;
    }
  }
  if (width < 1 || height < 1) return invalid();
  if (width > 6000 || height > 6000 || width * height > 20000000)
    throw new EpubImportError(
      'limit',
      'Встроенная обложка слишком велика: максимум 6000×6000 и 20 миллионов пикселей.',
    );
  return new Blob([bytes], { type: media });
}
