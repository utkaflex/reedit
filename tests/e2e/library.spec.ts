import { libraryAction } from '../fixtures/library-actions';
import { expect, test, type Page } from '@playwright/test';

async function createBook(page: Page, title = 'Тестовая книга') {
  await libraryAction(page, 'manual');
  await page
    .getByRole('textbox', { name: 'Название', exact: true })
    .fill(title);
  await page
    .getByRole('textbox', { name: 'Автор', exact: true })
    .fill('Тестовый автор');
  await page
    .getByRole('textbox', { name: 'Описание', exact: true })
    .fill('Тестовое описание');
  await page
    .getByRole('textbox', { name: 'Жанры', exact: true })
    .fill('Роман, Проза');
  await page.getByRole('button', { name: 'Добавить в библиотеку' }).click();
  await expect(
    page.getByRole('dialog', { name: title, exact: true }),
  ).toBeVisible();
}

test('книга, локальная обложка, отзыв, оценка и коллекция переживают перезагрузку', async ({
  page,
}) => {
  await page.goto('/');
  await libraryAction(page, 'manual');
  await page
    .getByRole('textbox', { name: 'Название', exact: true })
    .fill('Тестовая книга с обложкой');
  await page
    .getByRole('textbox', { name: 'Автор', exact: true })
    .fill('Тестовый автор');
  await page
    .getByRole('textbox', { name: 'Описание', exact: true })
    .fill('Сохранённое описание');
  await page
    .getByRole('textbox', { name: 'Жанры', exact: true })
    .fill('Роман, Проза');
  await page
    .getByRole('textbox', { name: 'ISBN (необязательно)' })
    .fill('9780140328721');
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 20;
    canvas.height = 30;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No canvas');
    context.fillStyle = '#395c45';
    context.fillRect(0, 0, 20, 30);
    return canvas.toDataURL('image/png').split(',')[1] ?? '';
  });
  await page.getByLabel('Обложка', { exact: true }).setInputFiles({
    name: 'cover.png',
    mimeType: 'image/png',
    buffer: Buffer.from(image, 'base64'),
  });
  await expect(page.getByAltText('Предпросмотр обложки')).toBeVisible();
  await page.getByRole('button', { name: 'Добавить в библиотеку' }).click();
  await page
    .getByRole('button', { name: 'Изменить прочтение 1', exact: true })
    .click();
  await page.getByLabel('Статус', { exact: true }).selectOption('finished');
  await page.getByLabel('Дата начала', { exact: true }).fill('2026-01-02');
  await page.getByLabel('Дата завершения', { exact: true }).fill('2026-01-10');
  await page.getByLabel('Оценка', { exact: true }).selectOption('4.5');
  await page
    .getByLabel('Личный отзыв', { exact: true })
    .fill('Хочу перечитать — личный отзыв.');
  await page.getByRole('button', { name: 'Сохранить прочтение' }).click();
  await expect(
    page.getByText('Оценка: 4,5 / 5', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page
    .getByRole('button', { name: 'Управлять коллекциями', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Создать коллекцию', exact: true })
    .click();
  await page
    .getByLabel('Название коллекции', { exact: true })
    .fill('Моя тестовая коллекция');
  await page
    .getByRole('checkbox', { name: 'Тестовая книга с обложкой' })
    .check();
  await page.getByRole('button', { name: 'Сохранить коллекцию' }).click();
  await expect(
    page.getByRole('heading', { name: 'Моя тестовая коллекция' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: /Фильтры и сортировка/ }).click();
  await page
    .getByLabel('Коллекция', { exact: true })
    .selectOption({ label: 'Моя тестовая коллекция' });
  await page
    .getByRole('button', { name: 'Показать книги', exact: true })
    .click();
  const books = page.getByRole('list', { name: 'Книги библиотеки' });
  await expect(books.getByRole('listitem')).toHaveCount(1);
  await expect(books.locator('img')).toHaveJSProperty('naturalWidth', 20);
  await books
    .getByRole('button', { name: /Тестовая книга с обложкой/ })
    .click();
  await page.getByRole('dialog').getByText('О книге', { exact: true }).click();
  await expect(
    page.getByText('Сохранённое описание', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Хочу перечитать — личный отзыв.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Оценка: 4,5 / 5', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Начало: 2026-01-02 · Завершение: 2026-01-10/),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('book-details.png'),
    scale: 'css',
    animations: 'disabled',
  });
});

test('редактирование, повторное прочтение и подтверждённое удаление', async ({
  page,
}) => {
  await page.goto('/');
  await createBook(page);
  await page
    .getByRole('button', { name: 'Редактировать книгу', exact: true })
    .click();
  await page
    .getByLabel('Название', { exact: true })
    .fill('Изменённая тестовая книга');
  await page.getByRole('button', { name: 'Сохранить изменения' }).click();
  await expect(
    page.getByRole('dialog', {
      name: 'Изменённая тестовая книга',
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Изменить прочтение 1', exact: true })
    .click();
  await page.getByLabel('Статус', { exact: true }).selectOption('finished');
  await page.getByLabel('Оценка', { exact: true }).selectOption('5');
  await page
    .getByLabel('Личный отзыв', { exact: true })
    .fill('Отзыв первого прочтения');
  await page.getByRole('button', { name: 'Сохранить прочтение' }).click();
  await page
    .getByRole('button', { name: 'Добавить прочтение', exact: true })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Прочтение 2 · Хочу прочитать',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText('Отзыв первого прочтения', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Удалить книгу', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Удалить книгу?', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(
    page.getByRole('dialog', {
      name: 'Изменённая тестовая книга',
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Удалить книгу', exact: true })
    .click();
  await page.getByRole('button', { name: 'Удалить книгу навсегда' }).click();
  await expect(
    page.getByRole('heading', { name: 'Первая книга — начало истории' }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Первая книга — начало истории' }),
  ).toBeVisible();
});

test('дубли, поиск, фильтры, список и подтверждение отмены редактирования', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  await createBook(page);
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await libraryAction(page, 'manual');
  await page.getByLabel('Название', { exact: true }).fill('Тестовая книга');
  await page.getByLabel('Автор', { exact: true }).fill('Тестовый автор');
  await page.getByRole('button', { name: 'Добавить в библиотеку' }).click();
  await expect(page.getByRole('alert')).toContainText('Похожая книга уже есть');
  await page
    .getByRole('button', { name: 'Открыть существующую книгу' })
    .click();
  await page
    .getByRole('button', { name: 'Редактировать книгу', exact: true })
    .click();
  await page
    .getByLabel('Название', { exact: true })
    .fill('Не должно сохраниться');
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Не сохранять изменения?' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Продолжить редактирование' }).click();
  await expect(page.getByLabel('Название', { exact: true })).toHaveValue(
    'Не должно сохраниться',
  );
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.getByRole('button', { name: 'Не сохранять', exact: true }).click();
  await page.getByLabel('Поиск по библиотеке', { exact: true }).fill('Проза');
  await expect(
    page.getByRole('list', { name: 'Книги библиотеки' }).getByRole('listitem'),
  ).toHaveCount(1);
  await page.getByRole('button', { name: /Фильтры и сортировка/ }).click();
  await page
    .getByLabel('Статус книги', { exact: true })
    .selectOption('finished');
  await page
    .getByRole('button', { name: 'Показать книги', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Ничего не найдено' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Сбросить поиск и фильтры' }).click();
  await page.getByText('Список', { exact: true }).click();
  await expect(page.locator('.book-list')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('library-list-320.png'),
    fullPage: true,
    scale: 'css',
  });
});
