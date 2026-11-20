import type { Page } from '@playwright/test';
export async function libraryAction(
  page: Page,
  action: 'upload' | 'manual' | 'catalog',
) {
  const name =
    action === 'upload'
      ? 'Загрузить EPUB или FB2'
      : action === 'manual'
        ? 'Добавить вручную'
        : 'Найти в каталоге';
  const direct = page.getByRole('button', { name, exact: true });
  const add = page.getByRole('button', { name: 'Добавить', exact: true });
  await direct.or(add).first().waitFor();
  if (await direct.isVisible()) {
    await direct.click();
    return;
  }
  await add.click();
  const dialog = page.getByRole('dialog', {
    name: 'Добавить в библиотеку',
    exact: true,
  });
  await dialog
    .getByRole('button', {
      name: new RegExp(name, 'u'),
    })
    .click();
}
