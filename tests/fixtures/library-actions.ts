import type { Page } from '@playwright/test';
export async function libraryAction(
  page: Page,
  action: 'upload' | 'manual' | 'catalog',
) {
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  const dialog = page.getByRole('dialog', {
    name: 'Добавить в библиотеку',
    exact: true,
  });
  await dialog
    .getByRole('button', {
      name:
        action === 'upload'
          ? /Загрузить EPUB или FB2/
          : action === 'manual'
            ? /Добавить вручную/
            : /Найти в каталоге/,
    })
    .click();
}
