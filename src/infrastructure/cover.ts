/** Validates a user-selected raster; never fetches remote covers. */
export async function copyCover(file: File): Promise<Blob> {
  if (
    !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
    file.size === 0 ||
    file.size > 10 * 1024 * 1024
  )
    throw new Error('Выберите JPG, PNG или WebP размером до 10 МБ.');
  const url = URL.createObjectURL(file);
  try {
    await new Promise<void>((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        if (
          image.naturalWidth < 1 ||
          image.naturalHeight < 1 ||
          image.naturalWidth > 6000 ||
          image.naturalHeight > 6000
        )
          reject(
            new Error(
              'Размер обложки должен быть не больше 6000 × 6000 пикселей.',
            ),
          );
        else resolve();
      };
      image.onerror = () => {
        reject(
          new Error('Не удалось прочитать изображение. Выберите другой файл.'),
        );
      };
      image.src = url;
    });
    return file.slice(0, file.size, file.type);
  } finally {
    URL.revokeObjectURL(url);
  }
}
