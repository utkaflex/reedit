import { libraryAction } from '../fixtures/library-actions';
import { expect, test, type Page } from '@playwright/test';
import { makeEpubFixture } from '../fixtures/epub';

async function open(page: Page) {
  const fixture = await makeEpubFixture({
    title: 'Книга с цитатами',
    chapters: [
      {
        name: 'chapter.xhtml',
        text: 'Спокойный русский текст для сохранения цитат. '.repeat(60),
      },
    ],
  });
  await page.goto('/');
  await libraryAction(page, 'upload');
  await page.getByLabel('Файл книги', { exact: true }).setInputFiles({
    name: 'notes.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(fixture.bytes),
  });
  await page
    .getByRole('button', { name: 'Создать книгу и сохранить EPUB' })
    .click();
  await page
    .getByRole('button', { name: 'Читать файл notes.epub', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Оформление чтения' }),
  ).toBeEnabled({ timeout: 20000 });
  return fixture;
}
async function select(page: Page, end = 22) {
  await page
    .frameLocator('iframe')
    .locator('p')
    .first()
    .evaluate((p, length) => {
      const node = p.firstChild;
      if (!node) throw new Error('Missing text');
      const range = p.ownerDocument.createRange();
      range.setStart(node, 0);
      range.setEnd(node, length);
      const selection = p.ownerDocument.defaultView?.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }, end);
  await expect(
    page.getByRole('group', { name: 'Действия с выделенным текстом' }),
  ).toBeVisible();
}
test('цитата, комментарий, цвет, закладка, экспорт, перезапуск и переход', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: (text: string) => {
          document.documentElement.dataset.copied = text;
          return Promise.resolve();
        },
      },
      configurable: true,
    });
    Object.defineProperty(navigator, 'share', {
      value: (data: ShareData) => {
        document.documentElement.dataset.shared = data.text ?? '';
        return Promise.resolve();
      },
      configurable: true,
    });
  });
  await open(page);
  await select(page, 18);
  // Moving native selection boundaries updates the captured payload, without creating a record.
  await select(page, 22);
  await page.getByRole('button', { name: 'Копировать', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute(
    'data-copied',
    'Спокойный русский текс',
  );
  await page.getByRole('button', { name: 'Поделиться', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute(
    'data-shared',
    'Спокойный русский текс',
  );
  await page.screenshot({
    path: test.info().outputPath('native-selection-menu.png'),
    scale: 'css',
  });
  await page.getByRole('button', { name: 'Заметка', exact: true }).click();
  await page
    .getByLabel('Комментарий', { exact: true })
    .fill('Вернуться к этой мысли');
  await page.getByRole('radio', { name: 'Шалфейный' }).check();
  await page.screenshot({
    path: test.info().outputPath('annotation-editor.png'),
    scale: 'css',
  });
  await page
    .getByRole('button', { name: 'Сохранить заметку', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('[ref="reedit-highlight"]')).toHaveCount(1);
  await page
    .getByRole('button', { name: 'Добавить закладку', exact: true })
    .click();
  await page
    .getByRole('textbox', { name: 'Название закладки', exact: true })
    .fill('Моя закладка');
  await page
    .getByRole('button', { name: 'Сохранить закладку', exact: true })
    .click();
  await page.getByRole('button', { name: 'Оформление чтения' }).click();
  await page.getByRole('radio', { name: 'Тёмная', exact: true }).check();
  await page.getByRole('button', { name: 'Применить оформление' }).click();
  await expect(page.locator('[ref="reedit-highlight"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Закрыть книгу' }).click();
  // Simulate a stale legacy CFI: validated offsets/context must rebuild the canonical target.
  await page.evaluate(async () => {
    const path = '/src/infrastructure/local-store.ts';
    const loaded: unknown = await import(path);
    const { createLocalStore } =
      loaded as typeof import('../../src/infrastructure/local-store');
    const store = createLocalStore();
    const notes = await store.repositories.annotations.list();
    const first = notes[0];
    if (!first) throw new Error('Missing annotation');
    await store.repositories.annotations.save(
      { ...first, cfi: 'outdated-invalid-cfi', updatedAt: first.updatedAt + 1 },
      { expectedUpdatedAt: first.updatedAt },
    );
    store.close();
  });
  await page.getByRole('link', { name: 'Цитаты', exact: true }).click();
  await expect(
    page.getByText('Вернуться к этой мысли', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText('Вернуться к этой мысли', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Редактировать', exact: true })
    .click();
  await page
    .getByLabel('Комментарий', { exact: true })
    .fill('Уточнённая мысль');
  await page.getByRole('button', { name: 'Сохранить изменения' }).click();
  await expect(
    page.getByText('Уточнённая мысль', { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('saved-quotes.png'),
    fullPage: true,
    scale: 'css',
  });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Экспорт Markdown' }).click();
  expect((await download).suggestedFilename()).toBe('reedit-quotes.md');
  await page.locator('.notes-filter-disclosure > summary').click();
  await page.getByLabel('Цвет', { exact: true }).selectOption('rose');
  await expect(page.locator('.saved-fragment')).toHaveCount(0);
  await page.getByLabel('Цвет', { exact: true }).selectOption('green');
  await expect(page.locator('.saved-fragment')).toHaveCount(1);
  await page.getByLabel('Созданы с', { exact: true }).fill('2999-01-01');
  await expect(page.locator('.saved-fragment')).toHaveCount(0);
  await page.getByLabel('Созданы с', { exact: true }).fill('');
  await page
    .getByLabel('Поиск цитат и заметок', { exact: true })
    .fill('не найдётся');
  await expect(page.locator('.saved-fragment')).toHaveCount(0);
  await page
    .getByLabel('Поиск цитат и заметок', { exact: true })
    .fill('Уточнённая');
  await expect(page.locator('.saved-fragment')).toHaveCount(1);
  await page.getByRole('button', { name: 'К месту в книге' }).click();
  await expect(
    page.getByRole('button', { name: 'Оформление чтения' }),
  ).toBeEnabled({ timeout: 20000 });
  await expect(page.locator('[ref="reedit-highlight"]')).toHaveCount(1);
  await page
    .getByRole('button', { name: 'Цитаты и закладки', exact: true })
    .click();
  await page
    .getByLabel('Показывать', { exact: true })
    .selectOption('bookmarks');
  await expect(
    page.getByRole('heading', { name: 'Моя закладка' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Редактировать', exact: true })
    .click();
  await page
    .getByRole('textbox', { name: 'Название закладки', exact: true })
    .fill('Новое имя');
  await page.getByRole('button', { name: 'Сохранить изменения' }).click();
  await expect(page.getByRole('heading', { name: 'Новое имя' })).toBeVisible();
  await page.getByRole('button', { name: 'Удалить', exact: true }).click();
  await page
    .getByRole('button', { name: 'Удалить фрагмент', exact: true })
    .click();
  await expect(page.locator('.saved-fragment')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('аннотации остаются после удаления файла; повторный импорт восстанавливает переход', async ({
  page,
}) => {
  const fixture = await open(page);
  await select(page);
  await page.getByRole('button', { name: 'Выделить', exact: true }).dblclick();
  await page.getByRole('button', { name: 'Закрыть книгу' }).click();
  await page
    .getByRole('list', { name: 'Книги библиотеки' })
    .getByRole('button', { name: /^Книга с цитатами/ })
    .click();
  await page.getByText('Файлы и издания', { exact: true }).click();
  await page.getByRole('button', { name: 'Убрать файл', exact: true }).click();
  await page
    .getByRole('button', { name: 'Убрать только файл', exact: true })
    .click();
  await page.getByRole('link', { name: 'Цитаты и заметки' }).click();
  await expect(page.locator('.saved-fragment')).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: 'К месту в книге' }),
  ).toBeDisabled();
  await page.reload();
  await expect(page.locator('.saved-fragment')).toHaveCount(1);
  await page.getByRole('link', { name: 'Цитаты', exact: true }).click();
  await expect(page.getByLabel('Книга', { exact: true })).toHaveValue('');
  await page.getByRole('link', { name: 'Библиотека', exact: true }).click();
  await page
    .getByRole('list', { name: 'Книги библиотеки' })
    .getByRole('button', { name: /^Книга с цитатами/ })
    .click();
  await page
    .getByRole('button', { name: 'Прикрепить EPUB', exact: true })
    .click();
  await page.getByLabel('Файл книги', { exact: true }).setInputFiles({
    name: 'same.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(fixture.bytes),
  });
  await page
    .getByRole('button', { name: 'Прикрепить EPUB', exact: true })
    .click();
  await page.getByRole('link', { name: 'Цитаты и заметки' }).click();
  await expect(
    page.getByRole('button', { name: 'К месту в книге' }),
  ).toBeEnabled();
});
