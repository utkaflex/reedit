import { expect, test } from '@playwright/test';

test('поля в диалоге: подписи, ошибки, фокус и узкий экран', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/tests/fixtures/components.html');
  await expect(
    page.getByRole('button', { name: 'Недоступное действие' }),
  ).toBeDisabled();
  const trigger = page.getByRole('button', { name: 'Проверить поле' });
  await trigger.click();
  const input = page.getByRole('textbox', { name: 'Название' });
  await expect(input).toHaveAccessibleDescription(
    'Введите не менее трёх символов',
  );
  await input.fill('Я');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(input).toHaveAccessibleDescription(
    'Введите не менее трёх символов Слишком короткое название',
  );
  await expect(input).toHaveCSS('font-size', '16px');
  await input.fill('Название');
  await expect(input).toHaveAttribute('aria-invalid', 'false');
  await page.getByRole('button', { name: 'Готово' }).click();
  await expect(trigger).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test('карточка имеет текстовую обложку при ошибке изображения и рабочее действие', async ({
  page,
}) => {
  await page.goto('/tests/fixtures/components.html');
  const card = page.getByRole('button', {
    name: /Тестовая книга с длинным названием/,
  });
  await expect(card.locator('img')).toHaveCount(0);
  await card.click();
  await expect(page.getByRole('status')).toHaveText(
    'Выбрана тестовая карточка',
  );
});
