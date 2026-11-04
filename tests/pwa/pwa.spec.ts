import { libraryAction } from '../fixtures/library-actions';
import { expect, test, chromium, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { makeEpubFixture } from '../fixtures/epub';

test.beforeEach(async ({ request }) => {
  await request.post('/__test/0');
});

test('длинная русская книга: production-импорт, полный индекс, последняя глава и освобождение iframe', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const sentence =
    'Длинный русский абзац сохраняет порядок слов, курсив и спокойный ритм чтения. ';
  const fixture = await makeEpubFixture({
    title: 'Нагрузочная книга CC0',
    cover: true,
    chapters: Array.from({ length: 4 }, (_, i) => ({
      name: `part${String(i)}.xhtml`,
      text: `Часть ${String(i + 1)}. ${sentence.repeat(1500)} Конец части ${String(i + 1)}.`,
    })),
    toc: [0, 3],
  });
  await page.goto('/');
  const started = Date.now();
  await libraryAction(page, 'upload');
  await page.getByLabel('Файл книги', { exact: true }).setInputFiles({
    name: 'large.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(fixture.bytes),
  });
  await page
    .getByRole('button', { name: 'Создать книгу и сохранить EPUB' })
    .click();
  await page
    .getByRole('button', { name: 'Читать файл large.epub', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Оформление чтения', exact: true }),
  ).toBeEnabled({ timeout: 90000 });
  const readyMs = Date.now() - started;
  await expect
    .poll(() =>
      page
        .frameLocator('iframe')
        .locator('img')
        .evaluate(
          (image) =>
            image instanceof HTMLImageElement && image.naturalWidth > 0,
        ),
    )
    .toBe(true);
  const sections = await page.evaluate(
    async () =>
      new Promise<string[]>((resolve, reject) => {
        const request = indexedDB.open('reedit');
        request.onerror = () => {
          reject(request.error ?? new Error('Open failed'));
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('documentTextIndexes', 'readonly');
          const query = tx.objectStore('documentTextIndexes').openCursor();
          query.onsuccess = () => {
            const value: unknown = query.result?.value;
            db.close();
            if (
              !value ||
              typeof value !== 'object' ||
              !('sections' in value) ||
              !Array.isArray(value.sections)
            ) {
              reject(new Error('Missing index'));
              return;
            }
            resolve(
              value.sections.map((section: unknown) => {
                if (
                  !section ||
                  typeof section !== 'object' ||
                  !('text' in section) ||
                  typeof section.text !== 'string'
                )
                  throw new Error('Invalid section');
                return section.text;
              }),
            );
          };
          query.onerror = () => {
            db.close();
            reject(query.error ?? new Error('Read failed'));
          };
        };
      }),
  );
  expect(sections).toEqual(fixture.expected);
  await page.getByRole('button', { name: 'Оглавление', exact: true }).click();
  await page.getByRole('button', { name: 'Раздел 4', exact: true }).click();
  await expect(page.frameLocator('iframe').locator('body')).toContainText(
    'Конец части 4.',
  );
  await page
    .getByRole('button', { name: 'Закрыть книгу', exact: true })
    .click();
  await expect(page.locator('iframe')).toHaveCount(0);
  const measurement = info.outputPath('large-book-measurement.json');
  await writeFile(
    measurement,
    JSON.stringify({
      readyMs,
      words: fixture.expected.join(' ').split(/\s+/u).length,
      sections: sections.length,
      compressedBytes: fixture.bytes.length,
      environment: info.project.name,
    }),
  );
  await info.attach('large-book-measurement.json', {
    path: measurement,
    contentType: 'application/json',
  });
});
test('контрольные суммы офлайн-манифеста совпадают с окончательными файлами production-сборки', async () => {
  const source = await readFile('dist/sw.js', 'utf8');
  const match = /const PRECACHE=(\[.*?\]);/.exec(source);
  if (!match?.[1]) throw new Error('No precache manifest');
  const entries: unknown = JSON.parse(match[1]);
  if (!Array.isArray(entries)) throw new Error('Invalid manifest');
  for (const entry of entries as unknown[]) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !('url' in entry) ||
      !('sha256' in entry) ||
      typeof entry.url !== 'string' ||
      typeof entry.sha256 !== 'string'
    )
      throw new Error('Invalid entry');
    expect(
      createHash('sha256')
        .update(await readFile(resolve('dist', `.${entry.url}`)))
        .digest('hex'),
    ).toBe(entry.sha256);
  }
});
async function ready(page: Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener(
          'controllerchange',
          () => {
            resolve();
          },
          { once: true },
        );
      });
  });
}
async function addBook(page: Page) {
  const fixture = await makeEpubFixture({
    title: 'Локальная книга PWA',
    chapters: [
      { name: 'first.xhtml', text: 'Начало синтетической книги.' },
      {
        name: 'last.xhtml',
        text: 'Последний раздел, сохранённый только на устройстве.',
      },
    ],
  });
  await libraryAction(page, 'upload');
  await page.getByLabel('Файл книги', { exact: true }).setInputFiles({
    name: 'offline.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(fixture.bytes),
  });
  await page
    .getByRole('button', { name: 'Создать книгу и сохранить EPUB' })
    .click();
  await page
    .getByRole('button', { name: 'Читать файл offline.epub', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Следующая страница', exact: true }),
  ).toBeEnabled({ timeout: 20000 });
  return fixture;
}
async function settings(page: Page) {
  await page.goto('/#/settings');
  await expect(
    page.getByRole('heading', { name: 'Офлайн и сохранность', exact: true }),
  ).toBeVisible();
}
async function waiting(page: Page) {
  return page.evaluate(async () =>
    Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
  );
}
test('возврат к книге во время применения обновления не перезагружает открытую страницу', async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    if (window.top !== window) return;
    sessionStorage.setItem(
      'loads',
      String(Number(sessionStorage.getItem('loads') ?? 0) + 1),
    );
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      sessionStorage.setItem(
        'controllers',
        String(Number(sessionStorage.getItem('controllers') ?? 0) + 1),
      );
    });
  });
  await ready(page);
  await addBook(page);
  await page
    .getByRole('button', { name: 'Следующая страница', exact: true })
    .click();
  await expect(
    page.getByText('Позиция сохранена', { exact: true }),
  ).toBeVisible();
  const readerHash = new URL(page.url()).hash;
  await page
    .getByRole('button', { name: 'Закрыть книгу', exact: true })
    .click();
  await expect(page).toHaveURL(/#\/library$/);
  await request.post('/__test/3');
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())?.update();
  });
  await expect.poll(() => waiting(page)).toBe(true);
  await settings(page);
  const before = await page.evaluate(() => ({
    loads: sessionStorage.getItem('loads'),
    controllers: Number(sessionStorage.getItem('controllers')),
  }));
  await page
    .getByRole('button', { name: 'Обновить приложение', exact: true })
    .click();
  await expect(
    page
      .getByRole('dialog', { name: 'Обновляем Reedit', exact: true })
      .getByText('Применяем обновление…', { exact: true }),
  ).toBeVisible();
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, readerHash);
  await expect
    .poll(() =>
      page.evaluate(() => Number(sessionStorage.getItem('controllers'))),
    )
    .toBe(before.controllers + 1);
  await expect(page.frameLocator('iframe').locator('body')).toContainText(
    'Последний раздел',
  );
  expect(await page.evaluate(() => sessionStorage.getItem('loads'))).toBe(
    before.loads,
  );
});

test('полный ZIP скачивается и восстанавливается через подтверждение; повреждение не меняет библиотеку', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await ready(page);
  await addBook(page);
  await page
    .getByRole('button', { name: 'Следующая страница', exact: true })
    .click();
  await expect(
    page.getByText('Позиция сохранена', { exact: true }),
  ).toBeVisible();
  const readerUrl = page.url();
  await page
    .getByRole('button', { name: 'Закрыть книгу', exact: true })
    .click();
  await expect(page).toHaveURL(/#\/library$/);
  await settings(page);
  await page
    .getByRole('button', { name: 'Создать ZIP резервной копии', exact: true })
    .click();
  const link = page.getByRole('link', {
    name: 'Скачать архив ZIP',
    exact: true,
  });
  await expect(link).toBeVisible({ timeout: 20000 });
  await page
    .getByRole('checkbox', {
      name: 'Включить файлы книг (EPUB и FB2)',
      exact: true,
    })
    .uncheck();
  await expect(link).toHaveCount(0);
  await page
    .getByRole('checkbox', {
      name: 'Включить файлы книг (EPUB и FB2)',
      exact: true,
    })
    .check();
  await page
    .getByRole('button', { name: 'Создать ZIP резервной копии', exact: true })
    .click();
  await expect(link).toBeVisible({ timeout: 20000 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('backup-settings.png'),
    fullPage: true,
  });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    link.click(),
  ]);
  const path = await download.path();
  if (!path) throw new Error('No archive');
  const bytes = await readFile(path);
  await page
    .getByRole('button', { name: 'Архив сохранён — подтвердить', exact: true })
    .click();
  await expect(page.getByText(/Последняя подтверждённая копия:/)).toBeVisible();
  await page.getByLabel('ZIP резервной копии', { exact: true }).setInputFiles({
    name: 'broken.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('corrupt'),
  });
  await expect(page.getByRole('alert')).toContainText('не прошла проверку');
  await page.getByLabel('ZIP резервной копии', { exact: true }).setInputFiles({
    name: 'backup.zip',
    mimeType: 'application/zip',
    buffer: bytes,
  });
  const confirm = page.getByRole('dialog', {
    name: 'Заменить библиотеку из копии?',
  });
  await expect(confirm).toBeVisible({ timeout: 20000 });
  await expect(
    confirm.getByRole('button', { name: 'Заменить библиотеку', exact: true }),
  ).toBeDisabled();
  await confirm.getByRole('checkbox').check();
  await confirm
    .getByRole('button', { name: 'Заменить библиотеку', exact: true })
    .click();
  await expect(page).toHaveURL(/#\/library$/);
  await expect(
    page
      .getByRole('list', { name: 'Книги библиотеки' })
      .getByRole('button', { name: /^Локальная книга PWA/ }),
  ).toBeVisible();
  await page.goto(readerUrl);
  await expect(
    page.getByRole('button', { name: 'Предыдущая страница', exact: true }),
  ).toBeEnabled({ timeout: 20000 });
  await expect(page.frameLocator('iframe').locator('body')).toContainText(
    'Последний раздел',
  );
});

test('закрытый браузер запускается офлайн из сохранённого профиля; ленивые разделы, файл и позиция доступны', async ({
  request,
}) => {
  test.setTimeout(90000);
  // A short isolated path avoids Windows profile/Service Worker path limits.
  const profile = resolve(
    test.info().project.outputDir,
    `offline-profile-${test.info().project.name}`,
  );
  let context = await chromium.launchPersistentContext(profile, {
    baseURL: 'http://127.0.0.1:4185',
    viewport: { width: 390, height: 844 },
  });
  let readerUrl: string;
  try {
    const page = await context.newPage();
    await ready(page);
    await addBook(page);
    await page
      .getByRole('button', { name: 'Следующая страница', exact: true })
      .click();
    await expect(
      page.getByText('Позиция сохранена', { exact: true }),
    ).toBeVisible();
    readerUrl = page.url();
    await page
      .getByRole('button', { name: 'Закрыть книгу', exact: true })
      .click();
    await expect(page).toHaveURL(/#\/library$/);
  } finally {
    await context.close();
  }
  context = await chromium.launchPersistentContext(profile, {
    baseURL: 'http://127.0.0.1:4185',
    viewport: { width: 390, height: 844 },
    offline: true,
  });
  try {
    const page = await context.newPage();
    await page.goto(readerUrl);
    await expect(
      page.getByRole('button', { name: 'Предыдущая страница', exact: true }),
    ).toBeEnabled({ timeout: 20000 });
    await expect(page.frameLocator('iframe').locator('body')).toContainText(
      'Последний раздел',
    );
    await page
      .getByRole('button', { name: 'Закрыть книгу', exact: true })
      .click();
    await expect(page).toHaveURL(/#\/library$/);
    await page.goto('/#/statistics');
    await page.getByText('Подробная статистика', { exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Ритм чтения', exact: true }),
    ).toBeVisible();
    await settings(page);
    await expect(
      page.getByText(
        'Интерфейс и все разделы доступны без интернета. Книги хранятся на устройстве.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole('button', {
        name: 'Создать ZIP резервной копии',
        exact: true,
      }),
    ).toBeEnabled();
    await page
      .getByRole('button', { name: 'Создать ZIP резервной копии', exact: true })
      .click();
    await expect(
      page.getByRole('link', { name: 'Скачать архив ZIP', exact: true }),
    ).toBeVisible({ timeout: 20000 });
    const cached = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys())
        for (const req of await (await caches.open(name)).keys())
          urls.push(req.url);
      return urls;
    });
    expect(
      cached.some((url) => url.includes('/api/') || /\.epub(?:$|\?)/.test(url)),
    ).toBe(false);
    expect(cached.some((url) => url.includes('StatisticsPage'))).toBe(true);
  } finally {
    await context.close();
  }
  await request.post('/__test/0');
});

test('обновление ожидает закрытия книги и других окон; версия с неверной целостностью не заменяет рабочую', async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(90000);
  await ready(page);
  await addBook(page);
  await page
    .getByRole('button', { name: 'Следующая страница', exact: true })
    .click();
  await expect(
    page.getByText('Позиция сохранена', { exact: true }),
  ).toBeVisible();
  const url = page.url();
  await request.post('/__test/1');
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())?.update();
  });
  await expect.poll(() => waiting(page), { timeout: 20000 }).toBe(true);
  await expect(page).toHaveURL(url);
  await expect(page.frameLocator('iframe').locator('body')).toContainText(
    'Последний раздел',
  );
  await page
    .getByRole('button', { name: 'Закрыть книгу', exact: true })
    .click();
  await expect(page).toHaveURL(/#\/library$/);
  await settings(page);
  const other = await context.newPage();
  await other.goto('/');
  await page
    .getByRole('button', { name: 'Обновить приложение', exact: true })
    .click();
  await expect(
    page.getByText(
      'Закройте остальные вкладки и окна Reedit, затем повторите.',
      { exact: true },
    ),
  ).toBeVisible();
  await other.close();
  await Promise.all([
    page.waitForEvent('load'),
    page
      .getByRole('button', { name: 'Обновить приложение', exact: true })
      .click(),
  ]);
  await expect.poll(() => waiting(page), { timeout: 20000 }).toBe(false);
  await expect(
    page.getByRole('heading', { name: 'Офлайн и сохранность', exact: true }),
  ).toBeVisible();
  await page.goto(url);
  await expect(page.frameLocator('iframe').locator('body')).toContainText(
    'Последний раздел',
  );
  await request.post('/__test/2');
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) throw new Error();
    await new Promise<void>((resolve, reject) => {
      registration.addEventListener(
        'updatefound',
        () => {
          const installing = registration.installing;
          installing?.addEventListener('statechange', () => {
            if (installing.state === 'redundant') resolve();
          });
        },
        { once: true },
      );
      void registration.update().catch(reject);
    });
  });
  expect(await waiting(page)).toBe(false);
  await context.setOffline(true);
  await page.reload();
  await expect(page.frameLocator('iframe').locator('body')).toContainText(
    'Последний раздел',
  );
  await context.setOffline(false);
});
