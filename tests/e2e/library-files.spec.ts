import { libraryAction } from '../fixtures/library-actions';
import { expect, test } from '@playwright/test';

test('удаление файла сохраняет книгу; редактирование и удаление коллекции не дублируют книги', async ({
  page,
}) => {
  await page.goto('/');
  await libraryAction(page, 'manual');
  await page
    .getByLabel('Название', { exact: true })
    .fill('Тест удаления файла');
  await page.getByRole('button', { name: 'Добавить в библиотеку' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Тест удаления файла', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  // Test-only fixture for an existing attached file; no EPUB import feature is exposed.
  await page.evaluate(
    async () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('reedit');
        request.onerror = () => {
          reject(request.error ?? new Error('Open failed'));
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(['books', 'bookFiles'], 'readwrite');
          const books = tx.objectStore('books').openCursor();
          books.onsuccess = () => {
            const book: unknown = books.result?.value;
            if (
              typeof book !== 'object' ||
              book === null ||
              !('id' in book) ||
              typeof book.id !== 'string'
            ) {
              tx.abort();
              return;
            }
            const now = Date.now();
            tx.objectStore('bookFiles').add({
              id: crypto.randomUUID(),
              bookId: book.id,
              createdAt: now,
              updatedAt: now,
              name: 'test.epub',
              mediaType: 'application/epub+zip',
              data: new Blob(['fixture']),
              sha256: null,
            });
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error ?? new Error('Aborted'));
          };
        };
      }),
  );
  await page.reload();
  await page
    .getByRole('list', { name: 'Книги библиотеки' })
    .getByRole('button', { name: 'Тест удаления файла' })
    .click();
  await page.getByText('Файлы и издания', { exact: true }).click();
  await page.getByRole('button', { name: 'Убрать файл', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Убрать файл EPUB?', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Убрать только файл' }).click();
  await expect(page.getByText(/Файл книги не прикреплён/)).toBeVisible();
  await expect(
    page.getByRole('heading', {
      name: 'Прочтение 1 · Хочу прочитать',
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.getByRole('button', { name: 'Коллекции', exact: true }).click();
  await page
    .getByRole('button', { name: 'Создать коллекцию', exact: true })
    .click();
  await page
    .getByLabel('Название коллекции', { exact: true })
    .fill('Коллекция один');
  await page.getByRole('checkbox', { name: 'Тест удаления файла' }).check();
  await page.getByRole('button', { name: 'Сохранить коллекцию' }).click();
  await page
    .getByRole('button', { name: 'Редактировать «Коллекция один»' })
    .click();
  await page
    .getByLabel('Название коллекции', { exact: true })
    .fill('Коллекция два');
  await page.getByRole('checkbox', { name: 'Тест удаления файла' }).uncheck();
  await page.getByRole('button', { name: 'Сохранить коллекцию' }).click();
  await expect(
    page.getByRole('heading', { name: 'Коллекция два', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('0 книг', { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: 'Удалить коллекцию «Коллекция два»' })
    .click();
  await page
    .getByRole('button', { name: 'Подтвердить удаление коллекции' })
    .click();
  await expect(
    page.getByText('Коллекций пока нет.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(
    page.getByRole('list', { name: 'Книги библиотеки' }).getByRole('listitem'),
  ).toHaveCount(1);
});
