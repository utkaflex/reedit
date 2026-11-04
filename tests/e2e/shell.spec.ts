import { expect, test } from '@playwright/test';

test('навигация, фокус, история и прямые ссылки', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Основные разделы' });
  await expect(
    page.getByRole('heading', { name: /^(Моя )?Библиотека$/, exact: true }),
  ).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Библиотека' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await nav.getByRole('link', { name: 'Статистика' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Статистика',
  );
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await nav.getByRole('link', { name: 'Настройки' }).click();
  await expect(page).toHaveURL(/#\/settings$/);
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Статистика',
  );
  await page.goForward();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Настройки');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Настройки');
});

test('автотема реагирует на систему; ручной выбор сохраняется', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/#/settings');
  await expect(
    page.getByText('Готово к сохранению данных', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.screenshot({
    path: test.info().outputPath('settings-dark.png'),
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
  await page.getByText('Тёмная', { exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Тёмная' })).toBeChecked();
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Тёмная' })).toBeChecked();
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await page.getByText('Авто', { exact: true }).click();
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
  await page.screenshot({
    path: test.info().outputPath('settings-light.png'),
    fullPage: true,
  });
  await page.getByRole('radio', { name: 'Авто' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'Светлая' })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Светлая' })).toBeFocused();
});

test('ошибка записи темы оставляет прежнее оформление и допускает повторение', async ({
  page,
}) => {
  await page.goto('/#/settings');
  await expect(
    page.getByText('Готово к сохранению данных', { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const originalPut = Object.getOwnPropertyDescriptor(
      IDBObjectStore.prototype,
      'put',
    );
    if (!originalPut) throw new Error('Missing IndexedDB put');
    IDBObjectStore.prototype.put = function () {
      Object.defineProperty(IDBObjectStore.prototype, 'put', originalPut);
      throw new DOMException('full', 'QuotaExceededError');
    };
  });
  await page.getByText('Тёмная', { exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Недостаточно места');
  await expect(page.getByRole('radio', { name: 'Авто' })).toBeChecked();
  await page.getByText('Тёмная', { exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Тёмная' })).toBeChecked();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('диалог и панель удерживают фокус, закрываются и возвращают фокус', async ({
  page,
}) => {
  await page.goto('/#/settings');
  for (const [triggerName, title] of [
    ['О хранении данных', 'На вашем устройстве'],
    ['О Reedit', 'О Reedit'],
  ] as const) {
    const trigger = page.getByRole('button', {
      name: new RegExp(`^${triggerName}`),
    });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: title, exact: true });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Shift+Tab');
    expect(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
    await page.keyboard.press('Tab');
    expect(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
  }
});

test('полноэкранная оболочка не показывает навигацию, неизвестный URL восстанавливается', async ({
  page,
}) => {
  await page.goto('/#/reading');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Чтение');
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await page.getByRole('link', { name: 'К библиотеке' }).click();
  await expect(page.getByRole('navigation')).toBeVisible();
  await page.goto('/#/missing');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Страница не найдена',
  );
  await page.getByRole('link', { name: 'К библиотеке', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    /^(Моя )?Библиотека$/,
  );
});

test('320 px, увеличенный текст и reduced motion без горизонтального скролла', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  for (const section of ['Библиотека', 'Статистика', 'Настройки']) {
    await page
      .getByRole('navigation')
      .getByRole('link', { name: section })
      .click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      section === 'Библиотека' ? /^(Моя )?Библиотека$/ : section,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(page.locator('.page-header')).toHaveCSS(
      'animation-name',
      'none',
    );
  }
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  const footer = await page.locator('.settings-stack').boundingBox();
  const navigation = await page.getByRole('navigation').boundingBox();
  expect(
    footer && navigation && footer.y + footer.height <= navigation.y,
  ).toBeTruthy();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '';
  });
  await page.screenshot({
    path: test.info().outputPath('settings-320.png'),
    fullPage: true,
  });
  await page
    .getByRole('navigation')
    .getByRole('link', { name: 'Библиотека' })
    .click();
  await page.screenshot({
    path: test.info().outputPath('library-320.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 932, height: 430 });
  await expect(page.locator('.app-rail')).not.toBeVisible();
  const landscapeNav = await page.getByRole('navigation').boundingBox();
  expect(
    landscapeNav && Math.abs(landscapeNav.y + landscapeNav.height - 430) <= 1,
  ).toBeTruthy();
});
