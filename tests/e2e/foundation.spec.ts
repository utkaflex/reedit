import { expect, test } from '@playwright/test';
test('хранилище доступно после перезагрузки, экран помещается на устройстве', async ({
  page,
}) => {
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Настройки');
  await expect(
    page.getByRole('radio', { name: 'Авто', exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: test.info().outputPath('foundation.png'),
    fullPage: true,
  });
  await page.reload();
  await expect(
    page.getByRole('radio', { name: 'Авто', exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('записи и Blob переживают перезагрузку в браузере', async ({ page }) => {
  await page.goto('/#/settings');
  await expect(
    page.getByRole('radio', { name: 'Авто', exact: true }),
  ).toBeEnabled();
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('reedit');
      request.onerror = () => {
        reject(request.error ?? new Error('IndexedDB request failed'));
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(['books', 'bookFiles'], 'readwrite');
        const bookId = crypto.randomUUID();
        const now = Date.now();
        tx.objectStore('books').add({
          id: bookId,
          title: 'E2E fixture',
          authors: [],
          isbn: [],
          catalogIds: [],
          description: '',
          genres: [],
          cover: null,
          language: null,
          createdAt: now,
          updatedAt: now,
        });
        tx.objectStore('bookFiles').add({
          id: crypto.randomUUID(),
          bookId,
          name: 'fixture.epub',
          mediaType: 'application/epub+zip',
          data: new Blob(['e2e-persistence']),
          sha256: null,
          createdAt: now,
          updatedAt: now,
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error('IndexedDB transaction failed'));
        };
      };
    });
  });
  await page.reload();
  await expect(
    page.getByRole('radio', { name: 'Авто', exact: true }),
  ).toBeEnabled();
  const text = await page.evaluate(
    async () =>
      new Promise<string>((resolve, reject) => {
        const request = indexedDB.open('reedit');
        request.onerror = () => {
          reject(request.error ?? new Error('IndexedDB request failed'));
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('bookFiles', 'readonly');
          const files = tx.objectStore('bookFiles').getAll();
          files.onsuccess = () => {
            const values: unknown = files.result;
            if (!Array.isArray(values)) {
              reject(new Error('Invalid records'));
              return;
            }
            const file: unknown = values[0];
            if (
              typeof file !== 'object' ||
              file === null ||
              !('data' in file) ||
              !(file.data instanceof Blob)
            ) {
              reject(new Error('Missing Blob'));
              return;
            }
            void file.data.text().then(resolve, reject);
          };
          tx.oncomplete = () => {
            db.close();
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error ?? new Error('IndexedDB transaction failed'));
          };
        };
      }),
  );
  expect(text).toBe('e2e-persistence');
});

test('отказ IndexedDB показывает ошибку и повторную проверку', async ({
  page,
}) => {
  await page.addInitScript(() => {
    IDBFactory.prototype.open = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
  });
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText(
    'Локальное хранилище недоступно.',
  );
  await page.getByRole('button', { name: 'Повторить проверку' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Локальное хранилище недоступно.',
  );
});
