import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { makeEpubFixture } from '../fixtures/epub';

async function counts(page: Page) {
  return page.evaluate(
    async () =>
      new Promise<Record<string, number>>((resolve, reject) => {
        const request = indexedDB.open('reedit');
        request.onerror = () => {
          reject(request.error ?? new Error('Open failed'));
        };
        request.onsuccess = () => {
          const db = request.result;
          const names = ['books', 'bookFiles', 'readings', 'epubIndexes'];
          const tx = db.transaction(names, 'readonly');
          const result: Record<string, number> = {};
          for (const name of names) {
            const query = tx.objectStore(name).count();
            query.onsuccess = () => {
              result[name] = query.result;
            };
          }
          tx.oncomplete = () => {
            db.close();
            resolve(result);
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error ?? new Error('Read failed'));
          };
        };
      }),
  );
}
async function storedBook(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('reedit');
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(request.error ?? new Error('Open failed'));
      };
    });
    try {
      const tx = db.transaction(['bookFiles', 'epubIndexes'], 'readonly');
      const read = (name: string) =>
        new Promise<unknown>((resolve, reject) => {
          const request = tx.objectStore(name).getAll();
          request.onsuccess = () => {
            const value: unknown = request.result;
            resolve(value);
          };
          request.onerror = () => {
            reject(request.error ?? new Error('Read failed'));
          };
        });
      const [files, indexes] = await Promise.all([
        read('bookFiles'),
        read('epubIndexes'),
      ]);
      if (!Array.isArray(files) || !Array.isArray(indexes))
        throw new Error('Invalid records');
      const file: unknown = files[0];
      const index: unknown = indexes[0];
      if (
        typeof file !== 'object' ||
        file === null ||
        !('data' in file) ||
        !(file.data instanceof Blob) ||
        !('sha256' in file) ||
        typeof file.sha256 !== 'string'
      )
        throw new Error('Missing original Blob/hash');
      if (
        typeof index !== 'object' ||
        index === null ||
        !('sections' in index) ||
        !Array.isArray(index.sections)
      )
        throw new Error('Missing index');
      const sections = index.sections.map((value: unknown) => {
        if (
          typeof value !== 'object' ||
          value === null ||
          !('text' in value) ||
          typeof value.text !== 'string' ||
          !('path' in value) ||
          typeof value.path !== 'string'
        )
          throw new Error('Invalid section');
        return { text: value.text, path: value.path };
      });
      return {
        hash: file.sha256,
        bytes: Array.from(new Uint8Array(await file.data.arrayBuffer())),
        sections,
      };
    } finally {
      db.close();
    }
  });
}

test('импорт всей книги, оригинал и SHA-256 переживают reload; повторный файл не дублируется', async ({
  page,
}) => {
  const fixture = await makeEpubFixture({
    chapters: [
      { name: 'z.xhtml', text: 'Начало главы.' },
      { name: 'a.xhtml', text: 'Продолжение главы.' },
      { name: 'tail.xhtml', text: 'Последняя часть без пункта оглавления.' },
    ],
    toc: [0],
    cover: true,
  });
  const outbound: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() !== 'GET' ||
      (/^https?:/.test(request.url()) &&
        !request.url().startsWith('http://127.0.0.1:4173/'))
    )
      outbound.push(request.url());
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Импорт EPUB', exact: true }).click();
  const upload = {
    name: 'synthetic.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(fixture.bytes),
  };
  await page.getByLabel('Файл EPUB', { exact: true }).setInputFiles(upload);
  await expect(page.getByText(/3 линейных ресурса/)).toBeVisible();
  expect(await counts(page)).toEqual({
    books: 0,
    bookFiles: 0,
    readings: 0,
    epubIndexes: 0,
  });
  await page.screenshot({
    path: test.info().outputPath('epub-review.png'),
    animations: 'disabled',
    scale: 'css',
  });
  await page
    .getByRole('button', { name: 'Создать книгу и сохранить EPUB' })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Синтетическая книга EPUB', exact: true }),
  ).toBeVisible();
  await page.reload();
  const data = await storedBook(page);
  expect(data.sections.map((section) => section.path)).toEqual(
    fixture.linearPaths,
  );
  expect(data.sections.map((section) => section.text)).toEqual(
    fixture.expected,
  );
  expect(Buffer.from(data.bytes)).toEqual(Buffer.from(fixture.bytes));
  expect(data.hash).toBe(
    createHash('sha256').update(fixture.bytes).digest('hex'),
  );
  await page.getByRole('button', { name: 'Импорт EPUB', exact: true }).click();
  await page
    .getByLabel('Файл EPUB', { exact: true })
    .setInputFiles({ ...upload, name: 'renamed.epub' });
  await expect(
    page.getByRole('heading', { name: 'Этот файл уже в библиотеке' }),
  ).toBeVisible();
  expect(await counts(page)).toEqual({
    books: 1,
    bookFiles: 1,
    readings: 1,
    epubIndexes: 1,
  });
  expect(outbound).toEqual([]);
});

test('прикрепление к существующей книге сохраняет её метаданные и отзыв', async ({
  page,
}) => {
  const fixture = await makeEpubFixture({ version: '2' });
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Добавить книгу', exact: true })
    .click();
  await page.getByLabel('Название', { exact: true }).fill('Мои метаданные');
  await page.getByRole('button', { name: 'Добавить в библиотеку' }).click();
  await page.getByRole('button', { name: 'Изменить прочтение 1' }).click();
  await page
    .getByLabel('Личный отзыв', { exact: true })
    .fill('Не заменять мой отзыв');
  await page.getByRole('button', { name: 'Сохранить прочтение' }).click();
  await page
    .getByRole('button', { name: 'Прикрепить EPUB', exact: true })
    .click();
  await page.getByLabel('Файл EPUB', { exact: true }).setInputFiles({
    name: 'epub2.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(fixture.bytes),
  });
  await expect(page.getByText(/1 линейный ресурс/)).toBeVisible();
  await expect(page.getByLabel('Куда импортировать')).not.toHaveValue('new');
  await page
    .getByRole('button', { name: 'Прикрепить EPUB', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Мои метаданные', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Не заменять мой отзыв', { exact: true }),
  ).toBeVisible();
  expect(await counts(page)).toEqual({
    books: 1,
    bookFiles: 1,
    readings: 1,
    epubIndexes: 1,
  });
});

test('DRM, повреждение и скрипты отклоняются без записей и исполнения HTML', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Импорт EPUB', exact: true }).click();
  for (const options of [
    { drm: true },
    { missingChapter: 0 },
    { unsafeMarkup: '<script>globalThis.epubUnsafe = true</script>' },
  ]) {
    const fixture = await makeEpubFixture(options);
    await page.getByLabel('Файл EPUB', { exact: true }).setInputFiles({
      name: 'bad.epub',
      mimeType: 'application/epub+zip',
      buffer: Buffer.from(fixture.bytes),
    });
    await expect(page.getByRole('alert')).toBeVisible();
    expect(await counts(page)).toEqual({
      books: 0,
      bookFiles: 0,
      readings: 0,
      epubIndexes: 0,
    });
    expect(await page.evaluate(() => 'epubUnsafe' in globalThis)).toBe(false);
  }
});

test('отмена во время анализа и до сохранения не создаёт частичную книгу', async ({
  page,
}) => {
  const fixture = await makeEpubFixture({
    chapters: Array.from({ length: 160 }, (_, index) => ({
      name: `part${String(index)}.xhtml`,
      text: 'Русский синтетический текст. '.repeat(200),
    })),
    toc: [0],
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Импорт EPUB', exact: true }).click();
  await page.getByLabel('Файл EPUB', { exact: true }).setInputFiles({
    name: 'cancel.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(fixture.bytes),
  });
  await page
    .getByRole('button', { name: 'Отменить импорт', exact: true })
    .click();
  await expect(
    page
      .getByRole('dialog', { name: 'Импорт EPUB', exact: true })
      .getByRole('status'),
  ).toContainText('Импорт отменён');
  expect(await counts(page)).toEqual({
    books: 0,
    bookFiles: 0,
    readings: 0,
    epubIndexes: 0,
  });
  const small = await makeEpubFixture();
  await page.getByLabel('Файл EPUB', { exact: true }).setInputFiles({
    name: 'review.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(small.bytes),
  });
  await expect(
    page.getByRole('button', { name: 'Создать книгу и сохранить EPUB' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Закрыть импорт', exact: true })
    .click();
  expect(await counts(page)).toEqual({
    books: 0,
    bookFiles: 0,
    readings: 0,
    epubIndexes: 0,
  });
});
