import { expect, test, type Page } from '@playwright/test';
import { makeFb2Fixture, expectedFb2Parts } from '../fixtures/fb2';
import { makeEpubFixture } from '../fixtures/epub';

async function importFb2(page: Page, source = makeFb2Fixture().source) {
  await page.getByRole('button', { name: 'Импорт FB2', exact: true }).click();
  await page.getByLabel('Файл FB2', { exact: true }).setInputFiles({
    name: 'book.fb2',
    mimeType: 'application/x-fictionbook+xml',
    buffer: Buffer.from(source),
  });
}
async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const path = '/src/infrastructure/local-store.ts';
    const loaded: unknown = await import(path);
    const store = (
      loaded as typeof import('../../src/infrastructure/local-store')
    ).createLocalStore();
    try {
      const files = await store.repositories.bookFiles.list();
      const indexes = await store.repositories.documentTextIndexes.list();
      return {
        files: await Promise.all(
          files.map(async (file) => ({
            id: file.id,
            mediaType: file.mediaType,
            sha256: file.sha256,
            source:
              file.mediaType === 'application/x-fictionbook+xml'
                ? await file.data.text()
                : '',
            derived: file.representation?.sha256,
          })),
        ),
        indexes: indexes.map((index) => ({
          sha256: index.sha256,
          sections: index.sections.map((section) => section.text),
        })),
        positions: await store.repositories.positions.list(),
        books: (await store.repositories.books.list()).length,
      };
    } finally {
      store.close();
    }
  });
}

test('FB2: оригинал, изображения, примечания и общая читалка; эквивалентный EPUB имеет тот же текст', async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 390, height: 844 });
  const external: string[] = [];
  page.on('request', (request) => {
    if (
      /^https?:/.test(request.url()) &&
      !request.url().startsWith('http://127.0.0.1:4173/')
    )
      external.push(request.url());
  });
  const fixture = makeFb2Fixture();
  await page.goto('/');
  await importFb2(page, fixture.source);
  await expect(page.getByText(/Иван Иванович Авторов, Соавтор/)).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'Встроенная обложка FB2' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Создать книгу и сохранить FB2' })
    .click();
  await page
    .getByRole('button', { name: 'Читать файл book.fb2', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Оформление чтения' }),
  ).toBeEnabled({ timeout: 20000 });
  await expect(page.frameLocator('iframe').locator('body')).toContainText(
    'Первая часть',
  );
  await page.getByRole('button', { name: 'Оглавление', exact: true }).click();
  await page.getByRole('button', { name: 'Подраздел', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Оформление чтения' }),
  ).toBeEnabled();
  await expect(page.frameLocator('iframe').locator('img')).toHaveCount(1);
  expect(
    await page
      .frameLocator('iframe')
      .locator('img')
      .evaluate(
        (image) =>
          image instanceof HTMLImageElement &&
          image.complete &&
          image.naturalWidth > 0,
      ),
  ).toBe(true);
  await page
    .frameLocator('iframe')
    .getByRole('link', { name: '1', exact: true })
    .click();
  await expect(page.locator('.reader-chapter')).toContainText('Примечание 1');
  await expect(page.frameLocator('iframe').locator('body')).toContainText(
    'Текст примечания.',
  );
  await page.getByRole('button', { name: 'Закрыть книгу' }).click();
  await expect(
    page.getByRole('heading', { name: 'Библиотека', exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole('list', { name: 'Книги библиотеки' })
    .getByRole('button', { name: /Синтетическая книга FB2/ })
    .click();
  await page
    .getByRole('button', { name: 'Читать файл book.fb2', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Оформление чтения' }),
  ).toBeEnabled({ timeout: 20000 });
  await expect(page.locator('.reader-chapter')).toContainText('Примечание 1');
  await page.getByRole('button', { name: 'Закрыть книгу' }).click();
  await expect(
    page.getByRole('heading', { name: 'Библиотека', exact: true }),
  ).toBeVisible();
  const stored = await snapshot(page);
  expect(stored.files[0]?.source).toBe(fixture.source);
  expect(stored.files[0]?.derived).not.toBe(stored.files[0]?.sha256);
  expect(stored.indexes[0]?.sections).toEqual(expectedFb2Parts);
  expect(stored.positions[0]?.cursor?.sha256).toBe(stored.files[0]?.sha256);
  const epub = await makeEpubFixture({
    title: 'Та же книга в EPUB',
    chapters: expectedFb2Parts.map((text, i) => ({
      name: `part-${String(i)}.xhtml`,
      text,
    })),
  });
  await page.getByRole('button', { name: 'Импорт EPUB', exact: true }).click();
  await page.getByLabel('Файл EPUB', { exact: true }).setInputFiles({
    name: 'same.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(epub.bytes),
  });
  await page
    .getByRole('button', { name: 'Создать книгу и сохранить EPUB' })
    .click();
  await page
    .getByRole('button', { name: 'Читать файл same.epub', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Оформление чтения' }),
  ).toBeEnabled({ timeout: 20000 });
  const both = await snapshot(page);
  expect(both.indexes).toHaveLength(2);
  expect(both.indexes[0]?.sections).toEqual(both.indexes[1]?.sections);
  expect(external).toEqual([]);
});

test('повторный FB2 и опасный XML не создают лишних записей', async ({
  page,
}) => {
  const remote: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith('https://example.org/'))
      remote.push(request.url());
  });
  await page.goto('/');
  await importFb2(page);
  await page
    .getByRole('button', { name: 'Создать книгу и сохранить FB2' })
    .click();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await importFb2(page);
  await expect(
    page.getByRole('heading', { name: 'Этот файл уже в библиотеке' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть импорт' }).click();
  const unsafe = makeFb2Fixture().source.replace(
    '<FictionBook',
    '<!DOCTYPE FictionBook SYSTEM "https://example.org/external.dtd"><FictionBook',
  );
  await importFb2(page, unsafe);
  await expect(page.getByRole('alert')).toContainText('сущностей');
  expect((await snapshot(page)).books).toBe(1);
  expect((await snapshot(page)).files).toHaveLength(1);
  expect(remote).toEqual([]);
});
