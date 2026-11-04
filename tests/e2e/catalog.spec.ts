import { libraryAction } from '../fixtures/library-actions';
import { expect, test, type Page } from '@playwright/test';
import {
  catalogEdition,
  catalogOtherEdition,
  catalogWork,
  googleVolume,
} from '../fixtures/catalog';
import { makeEpubFixture } from '../fixtures/epub';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=',
  'base64',
);
async function mockCatalog(page: Page) {
  const requests: string[] = [];
  await page.route(
    'https://books.google.com/googlebooks/images/poweredby.png',
    (route) => route.fulfill({ contentType: 'image/png', body: png }),
  );
  await page.route('**/api/catalog/**', async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    if (url.pathname.endsWith('/cover')) {
      await route.fulfill({ contentType: 'image/png', body: png });
      return;
    }
    let body: unknown = {};
    if (url.pathname.endsWith('open/search'))
      body = { docs: [catalogWork], numFound: 1 };
    if (url.pathname.endsWith('open/work'))
      body = { description: { value: 'Синтетическое описание из каталога.' } };
    if (url.pathname.endsWith('open/editions'))
      body = { entries: [catalogEdition, catalogOtherEdition], size: 2 };
    if (url.pathname.endsWith('open/edition'))
      body =
        url.searchParams.get('id') === 'OL102M'
          ? catalogOtherEdition
          : catalogEdition;
    if (url.pathname.endsWith('google/search'))
      body = { items: [googleVolume], totalItems: 1 };
    if (url.pathname.endsWith('google/volume')) body = googleVolume;
    await route.fulfill({
      json: body,
      headers: { 'Cache-Control': 'private, max-age=600' },
    });
  });
  return requests;
}
async function search(page: Page) {
  await libraryAction(page, 'catalog');
  await page
    .getByLabel('Запрос в каталог', { exact: true })
    .fill('Преступление и наказание');
  await page
    .getByRole('button', {
      name: 'Выбрать издание «Преступление и наказание»',
      exact: true,
    })
    .click();
  await page
    .getByRole('button', { name: 'Выбрать OL101M', exact: true })
    .click();
  await expect(page.getByLabel('Название книги', { exact: true })).toHaveValue(
    'Преступление и наказание',
  );
}
async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const path = '/src/infrastructure/local-store.ts';
    const loaded: unknown = await import(path);
    const { createLocalStore } =
      loaded as typeof import('../../src/infrastructure/local-store');
    const store = createLocalStore();
    try {
      const data = await store.readLibrary();
      return {
        books: data.books.map((book) => ({
          id: book.id,
          title: book.title,
          cover: book.cover?.size ?? 0,
        })),
        files: data.files.length,
        readings: data.readings,
        sources: await store.repositories.catalogSelections.list(),
      };
    } finally {
      store.close();
    }
  });
}
test('издание → локальная книга → исправление обложки → свой EPUB без дубля', async ({
  page,
}) => {
  await mockCatalog(page);
  await page.goto('/');
  await search(page);
  await expect(
    page.getByLabel('Издательство издания', { exact: true }),
  ).toHaveValue('Тестовое издательство');
  await page
    .getByLabel('Альтернативная обложка каталога', { exact: true })
    .selectOption({ label: 'Обложка 2' });
  await page
    .getByLabel('Ваше описание', { exact: true })
    .fill('Личное описание книги');
  await page.screenshot({
    path: test.info().outputPath('catalog-edition.png'),
    fullPage: true,
    scale: 'css',
  });
  await page
    .getByRole('button', { name: 'Добавить издание в библиотеку', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Редактировать книгу', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Редактировать книгу', exact: true })
    .click();
  await page
    .getByRole('textbox', { name: 'Название', exact: true })
    .fill('Моя редакция метаданных');
  await page.getByLabel('Обложка', { exact: true }).setInputFiles({
    name: 'my-cover.png',
    mimeType: 'image/png',
    buffer: png,
  });
  await expect(page.getByAltText('Предпросмотр обложки')).toBeVisible();
  await page
    .getByRole('button', { name: 'Сохранить изменения', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Прикрепить EPUB', exact: true })
    .click();
  const fixture = await makeEpubFixture({
    title: 'Мой EPUB',
    chapters: [
      { name: 'chapter.xhtml', text: 'Собственный синтетический текст.' },
    ],
  });
  await page.getByLabel('Файл книги', { exact: true }).setInputFiles({
    name: 'my.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(fixture.bytes),
  });
  await page
    .getByRole('button', { name: 'Прикрепить EPUB', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Читать файл my.epub' }),
  ).toBeVisible();
  const before = await snapshot(page);
  expect(before.books).toHaveLength(1);
  expect(before.files).toBe(1);
  expect(before.books[0]?.cover).toBeGreaterThan(0);
  expect(before.sources[0]).toMatchObject({
    editionId: 'OL101M',
    selectedCover: expect.stringContaining('/102-'),
  });
  await page.reload();
  const after = await snapshot(page);
  expect(after.books).toEqual(before.books);
  expect(after.files).toBe(1);
});
test('повторное издание сопоставляется явно и сохраняет отзыв и историю', async ({
  page,
}) => {
  await mockCatalog(page);
  await page.goto('/');
  await search(page);
  await page
    .getByRole('button', { name: 'Сохранить без обложки', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Добавить издание в библиотеку', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Редактировать книгу', exact: true }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const path = '/src/infrastructure/local-store.ts';
    const loaded: unknown = await import(path);
    const { createLocalStore } =
      loaded as typeof import('../../src/infrastructure/local-store');
    const store = createLocalStore();
    try {
      const reading = (await store.repositories.readings.list())[0];
      if (!reading) throw new Error('Missing reading');
      await store.repositories.readings.save({
        ...reading,
        rating: 4.5,
        review: 'Мой отзыв',
        updatedAt: reading.updatedAt + 1,
      });
    } finally {
      store.close();
    }
  });
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await search(page);
  await page
    .getByRole('button', { name: 'Сохранить без обложки', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Добавить издание в библиотеку', exact: true })
    .click();
  await expect(
    page.getByText('Совпадает ISBN или идентификатор издания.', {
      exact: false,
    }),
  ).toBeVisible();
  await page
    .getByRole('button', {
      name: 'Связать с «Преступление и наказание»',
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('checkbox', {
      name: 'Заменить метаданные книги значениями из формы ниже',
    }),
  ).not.toBeChecked();
  await page
    .getByRole('button', {
      name: 'Сопоставить с существующей книгой',
      exact: true,
    })
    .click();
  await expect(page.getByText('Мой отзыв', { exact: true })).toBeVisible();
  const data = await snapshot(page);
  expect(data.books).toHaveLength(1);
  expect(data.readings).toHaveLength(1);
  expect(data.sources).toHaveLength(1);
  expect(data.readings[0]?.rating).toBe(4.5);
});
test('debounce, кэш и офлайн не отправляют устаревшие запросы и не мешают ручному добавлению', async ({
  page,
  context,
}) => {
  const requests = await mockCatalog(page);
  await page.goto('/');
  await libraryAction(page, 'catalog');
  await page.getByLabel('Запрос в каталог', { exact: true }).fill('Старый');
  await page.getByLabel('Запрос в каталог', { exact: true }).fill('Новый');
  await expect(
    page.getByRole('button', {
      name: 'Выбрать издание «Преступление и наказание»',
    }),
  ).toBeVisible();
  expect(requests.filter((path) => path.includes('open/search'))).toHaveLength(
    1,
  );
  expect(requests.join(' ')).not.toContain('Старый');
  await context.setOffline(true);
  await page.getByLabel('Запрос в каталог', { exact: true }).fill('Другое');
  await expect(
    page.getByText(
      'Нет интернета. Локальная библиотека и ручное добавление доступны.',
      { exact: true },
    ),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Закрыть поиск', exact: true })
    .click();
  await libraryAction(page, 'manual');
  await expect(
    page.getByRole('textbox', { name: 'Название', exact: true }),
  ).toBeVisible();
});
test('Google: свой источник и атрибуция, описание API не становится пользовательским', async ({
  page,
}) => {
  await mockCatalog(page);
  await page.goto('/');
  await libraryAction(page, 'catalog');
  await page
    .getByLabel('Источник каталога', { exact: true })
    .selectOption('google-books');
  await page.getByLabel('Язык поиска', { exact: true }).selectOption('en');
  await page
    .getByLabel('Запрос в каталог', { exact: true })
    .fill('Crime and Punishment');
  await expect(page.getByAltText('Powered by Google')).toBeVisible();
  await page
    .getByRole('button', {
      name: 'Выбрать издание «Crime and Punishment»',
      exact: true,
    })
    .click();
  await page
    .getByRole('button', { name: 'Выбрать synthetic-volume', exact: true })
    .click();
  await expect(page.getByLabel('Ваше описание', { exact: true })).toHaveValue(
    '',
  );
  await page
    .getByLabel('Ваше описание', { exact: true })
    .fill('Моя заметка о книге');
  await page
    .getByRole('button', { name: 'Добавить издание в библиотеку', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Редактировать книгу', exact: true }),
  ).toBeVisible();
  const data = await snapshot(page);
  expect(data.sources[0]).toMatchObject({
    source: 'google-books',
    snapshot: null,
  });
  expect(data.books[0]?.cover).toBe(0);
  const preview = page.getByRole('img', {
    name: 'Обложка «Crime and Punishment»',
    exact: true,
  });
  await expect(preview).toHaveAttribute('src', /\/api\/catalog\/cover/);
  await expect
    .poll(() =>
      preview.evaluate(
        (image) => image instanceof HTMLImageElement && image.naturalWidth > 0,
      ),
    )
    .toBe(true);
});

test('устаревший ответ не заменяет новый поиск; отсутствие ключа Google объясняется явно', async ({
  page,
}) => {
  await mockCatalog(page);
  let releaseOld = () => {};
  const old = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  await page.route('**/api/catalog/open/search?**', async (route) => {
    const text = new URL(route.request().url()).searchParams.get('text');
    if (text === 'Старый запрос') await old;
    await route
      .fulfill({
        json: {
          numFound: 1,
          docs: [
            {
              ...catalogWork,
              title:
                text === 'Старый запрос'
                  ? 'Устаревший результат'
                  : 'Свежий результат',
            },
          ],
        },
      })
      .catch(() => {});
  });
  await page.goto('/');
  await libraryAction(page, 'catalog');
  const sent = page.waitForRequest((request) =>
    request.url().includes('open/search'),
  );
  await page
    .getByLabel('Запрос в каталог', { exact: true })
    .fill('Старый запрос');
  await sent;
  await page
    .getByLabel('Запрос в каталог', { exact: true })
    .fill('Новый запрос');
  await expect(
    page.getByRole('button', { name: 'Выбрать издание «Свежий результат»' }),
  ).toBeVisible();
  releaseOld();
  await expect(
    page.getByRole('button', {
      name: 'Выбрать издание «Устаревший результат»',
    }),
  ).toHaveCount(0);
  await page.route('**/api/catalog/google/search?**', (route) =>
    route.fulfill({ status: 503, json: { message: 'Server API key missing' } }),
  );
  await page
    .getByLabel('Источник каталога', { exact: true })
    .selectOption('google-books');
  await expect(
    page.getByText(
      'Источник не настроен или временно недоступен. Попробуйте другой каталог.',
      { exact: true },
    ),
  ).toBeVisible();
});
