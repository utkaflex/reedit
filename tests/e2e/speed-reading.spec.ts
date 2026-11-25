import { libraryAction } from '../fixtures/library-actions';
import { expect, test, type Page } from '@playwright/test';
import { makeEpubFixture } from '../fixtures/epub';
async function open(page: Page, long = false) {
  const fixture = await makeEpubFixture({
    title: 'Текст для скорочтения',
    chapters: [
      {
        name: 'a.xhtml',
        text: 'Первое второе третье. Четвёртое пятое.',
        ...(long
          ? {
              markup: `<p>${'Спокойный русский текст без пропусков. '.repeat(12)}</p>`,
            }
          : {}),
      },
      { name: 'b.xhtml', text: 'Шестое седьмое восьмое.' },
    ],
    toc: [0],
  });
  await page.goto('/');
  await libraryAction(page, 'upload');
  await page.getByLabel('Файл книги', { exact: true }).setInputFiles({
    name: 'speed.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(fixture.bytes),
  });
  await page.getByRole('button', { name: 'Добавить в библиотеку' }).click();
  await page.getByRole('button', { name: 'Читать файл speed.epub' }).click();
  await expect(
    page.getByRole('button', { name: 'Режимы', exact: true }),
  ).toBeEnabled({ timeout: 20000 });
}
async function mode(page: Page, name: 'RSVP' | 'Guided') {
  await page.getByRole('button', { name: 'Режимы', exact: true }).click();
  await page
    .getByRole('button', {
      name: name === 'RSVP' ? 'По одному слову' : 'С подсветкой текста',
    })
    .click();
  await expect(
    page.getByRole('button', { name: 'Продолжить', exact: true }),
  ).toBeEnabled({ timeout: 20000 });
}
async function saved(page: Page) {
  return page.evaluate(async () => {
    const path = '/src/infrastructure/local-store.ts';
    const loaded: unknown = await import(path);
    const { createLocalStore } =
      loaded as typeof import('../../src/infrastructure/local-store');
    const store = createLocalStore();
    try {
      return (await store.repositories.positions.list())[0]?.cursor ?? null;
    } finally {
      store.close();
    }
  });
}

test.use({
  video: process.env.REEDIT_RECORD_SPEED
    ? { mode: 'on', size: { width: 320, height: 740 } }
    : 'off',
});
test('подсветка проходит границу глав @comparison', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'Мобильный профиль');
  test.setTimeout(45000);
  const videoStart = performance.now();
  const motion =
    process.env.REEDIT_COMPARE_SPEED === 'reduce' ? 'reduce' : 'no-preference';
  const baseline = process.env.REEDIT_SPEED_BASELINE === '1';
  const sampleDuration = process.env.REEDIT_RECORD_SPEED ? 9200 : 7700;
  await page.emulateMedia({ reducedMotion: motion });
  await page.setViewportSize({ width: 320, height: 740 });
  const lead =
    'В отдалении виднелся огонёк маяка, а неподвижное море темнело под нависшими облаками.';
  const phrase =
    'Путник медленно шёл по берегу и прислушивался к ветру, который разгонял туман над непривычно тихой гаванью.';
  const next =
    'За последним поворотом открылась широкая набережная, и стало слышно, как волны разбиваются о каменные ступени старой пристани.';
  const fixture = await makeEpubFixture({
    title: 'Дорога к маяку',
    chapters: [
      {
        name: 'a.xhtml',
        text: '',
        markup: `<h1>Берег</h1><p>${(lead + ' ').repeat(12)}</p><p>Дорога к маяку. ${(phrase + ' ').repeat(3)}</p>`,
      },
      {
        name: 'b.xhtml',
        text: '',
        markup: `<h1 id="next-chapter">Набережная</h1><p>${(next + ' ').repeat(16)}</p>`,
      },
    ],
  });
  await page.goto('/');
  await libraryAction(page, 'upload');
  await page.getByLabel('Файл книги', { exact: true }).setInputFiles({
    name: 'lighthouse.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(fixture.bytes),
  });
  await page.getByRole('button', { name: 'Добавить и читать' }).click();
  await page.getByRole('button', { name: 'Поиск по книге' }).click();
  await page
    .getByRole('searchbox', { name: 'Слово или фраза' })
    .fill('Дорога к маяку');
  await page
    .getByRole('dialog', { name: 'Поиск по книге' })
    .getByRole('list')
    .getByRole('button')
    .click();
  await page.getByRole('button', { name: 'Читать отсюда' }).click();
  await mode(page, 'Guided');
  const tempo = process.env.REEDIT_COMPARE_WPM ?? '480';
  await page.getByRole('button', { name: /слов\/мин/ }).click();
  await page.getByRole('spinbutton', { name: 'Слов в минуту' }).fill(tempo);
  await page.getByRole('button', { name: 'Применить настройки' }).click();

  const host = page.getByTestId('reader-host');
  const viewport = host.locator('.epub-container');
  const progress = host.locator('.speed-word-highlight').first();
  const chapter = host
    .locator('iframe')
    .filter({ visible: true })
    .last()
    .contentFrame()
    .locator('#next-chapter');
  await expect(progress).toBeVisible();
  await page.evaluate(() => {
    const host = document.querySelector('[data-testid="reader-host"]');
    const guide = document.createElement('div');
    guide.style.cssText =
      'position:absolute;inset:50% 0 auto;height:1px;box-shadow:inset 8px 0 #976754,inset -8px 0 #976754;pointer-events:none;z-index:20';
    host?.append(guide);
  });
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  const start = Math.round(performance.now() - videoStart);
  const stats = await viewport.evaluate(async (element, duration) => {
    const samples: { delta: number; distance: number | null }[] = [];
    let previous = element.scrollTop;
    const start = performance.now();
    await new Promise<void>((resolve) => {
      const sample = () => {
        const rect = element.getBoundingClientRect();
        const mark = element.parentElement
          ?.querySelector('.speed-word-highlight')
          ?.getBoundingClientRect();
        samples.push({
          delta: element.scrollTop - previous,
          distance: mark
            ? Math.abs(mark.top + mark.height / 2 - rect.top - rect.height / 2)
            : null,
        });
        previous = element.scrollTop;
        if (performance.now() - start < duration) requestAnimationFrame(sample);
        else resolve();
      };
      requestAnimationFrame(sample);
    });
    return {
      maxStep: Math.max(...samples.map(({ delta }) => Math.abs(delta))),
      movingFrames: samples.filter(({ delta }) => Math.abs(delta) > 0).length,
      nearCenter:
        samples.filter(({ distance }) => distance !== null && distance < 32)
          .length / samples.length,
    };
  }, sampleDuration);
  console.log({ start, tempo, motion, ...stats });
  const pause = page.getByRole('button', { name: 'Пауза', exact: true });
  if (baseline) {
    await expect(chapter).toBeInViewport({ timeout: 18000 });
  } else {
    await expect
      .poll(async () => (await saved(page))?.spineIndex, { timeout: 18000 })
      .toBe(1);
    expect(stats.nearCenter).toBeGreaterThan(0.65);
    if (motion === 'reduce') expect(stats.movingFrames).toBeLessThan(40);
    if (!process.env.REEDIT_RECORD_SPEED) {
      const speed = Number(tempo);
      await page.getByRole('button', { name: 'Увеличить скорость' }).click();
      await expect(
        page.getByRole('button', { name: `${String(speed + 10)} слов/мин` }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Уменьшить скорость' }).click();
      await expect(
        page.getByRole('button', { name: `${tempo} слов/мин` }),
      ).toBeVisible();
    }
  }
  await pause.click();
  const pausedAt = await viewport.evaluate((element) => element.scrollTop);
  const wordAtPause = baseline ? null : await saved(page);
  await page.waitForTimeout(90);
  const pausedMark = await progress.boundingBox();
  await page.waitForTimeout(300);
  expect(await viewport.evaluate((element) => element.scrollTop)).toBe(
    pausedAt,
  );
  expect(await progress.boundingBox()).toEqual(pausedMark);
  if (wordAtPause) expect(await saved(page)).toEqual(wordAtPause);
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await expect.poll(() => progress.boundingBox()).not.toEqual(pausedMark);
  await page.getByRole('button', { name: 'К тексту', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Режимы', exact: true }),
  ).toBeVisible();
});

test('оформление и пульт чтения помещаются на узком телефоне', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await open(page, true);
  const stage = await page.locator('.reader-stage').boundingBox();
  expect(stage?.height).toBeGreaterThan(500);
  await page
    .getByRole('button', { name: 'Оформление чтения', exact: true })
    .click();
  await page.getByRole('radio', { name: 'Сепия', exact: true }).check();
  await expect(
    page.getByRole('radio', { name: 'Сепия', exact: true }),
  ).toBeChecked();
  await page.screenshot({
    path: test.info().outputPath('reader-appearance.png'),
    scale: 'css',
  });
  await page
    .getByRole('button', { name: 'Применить оформление', exact: true })
    .click();
  await expect(page.locator('.reader-screen')).toHaveAttribute(
    'data-reader-theme',
    'sepia',
  );
  await mode(page, 'RSVP');
  const controls = page.getByRole('region', {
    name: 'Управление скорочтением',
  });
  const boxes = await controls.getByRole('button').evaluateAll((buttons) =>
    buttons.map((button) => {
      const box = button.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        width: box.width,
        height: box.height,
      };
    }),
  );
  for (const box of boxes) {
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(320);
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({
    path: test.info().outputPath('reader-rsvp.png'),
    scale: 'css',
  });
  await page.getByRole('button', { name: 'К тексту', exact: true }).click();
  await expect(page.locator('.speed-word-highlight').first()).toBeVisible();
});

test('крупный шрифт и выравнивание сохраняют абзац и ширину страницы', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const longWord = 'высокоспециализированноеэлектромашиностроение';
  const fixture = await makeEpubFixture({
    cover: true,
    chapters: [
      {
        name: 'first.xhtml',
        text: '',
        markup: `<h1>Старая пристань</h1><p>${'Рыбацкая лодка тихо качалась возле старых деревянных ступеней. '.repeat(32)}</p><p id="target">У дальнего причала заметили огни. Слово ${longWord} занимало целую строку.</p><p><img src="cover.png" alt="Большая иллюстрация" style="width:1200px" /></p>`,
      },
    ],
  });
  await page.goto('/');
  await libraryAction(page, 'upload');
  await page.getByLabel('Файл книги', { exact: true }).setInputFiles({
    name: 'appearance.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(fixture.bytes),
  });
  await page.getByRole('button', { name: 'Добавить и читать' }).click();
  await page.getByRole('button', { name: 'Поиск по книге' }).click();
  await page.getByRole('searchbox').fill('У дальнего причала');
  await page
    .getByRole('dialog', { name: 'Поиск по книге' })
    .getByRole('list')
    .getByRole('button')
    .click();
  await page.getByRole('button', { name: 'Читать отсюда' }).click();
  const frame = page
    .getByTestId('reader-host')
    .locator('iframe')
    .contentFrame();
  const paragraph = frame.locator('#target');
  await expect(paragraph).toBeInViewport();
  const cursor = await saved(page);
  await page.getByRole('button', { name: 'Оформление чтения' }).click();
  const settings = page.getByRole('dialog', { name: 'Оформление чтения' });
  await expect(settings.getByText('Светлая', { exact: true })).toBeInViewport();
  await expect(
    settings.getByText('Системный', { exact: true }),
  ).toBeInViewport();
  const larger = settings.getByRole('button', { name: 'Увеличить шрифт' });
  await expect(larger).toBeInViewport();
  for (let i = 0; i < 12; i++) await larger.click();
  await expect(larger).toBeDisabled();
  await settings.getByRole('radio', { name: 'Системный' }).check();
  await settings.getByRole('radio', { name: 'По ширине' }).check();
  await settings.getByRole('radio', { name: 'Сепия' }).check();
  await settings.getByRole('button', { name: 'Применить оформление' }).click();
  await expect(settings).toBeHidden();
  await expect(paragraph).toBeInViewport();
  await expect(paragraph).toHaveCSS('font-size', '32px');
  await expect(paragraph).toHaveCSS('text-align', 'justify');
  expect(
    await paragraph.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  expect(await saved(page)).toEqual(cursor);
  const illustration = frame.getByRole('img', { name: 'Большая иллюстрация' });
  expect(
    await illustration.evaluate(
      (element) =>
        element.getBoundingClientRect().width <=
        element.ownerDocument.documentElement.clientWidth,
    ),
  ).toBe(true);
});
test('RSVP: точная передача, шаги, конец spine, возврат и перезапуск', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await open(page);
  const entry = await saved(page);
  await mode(page, 'RSVP');
  await expect(page.getByLabel('Текущее слово', { exact: true })).toHaveText(
    'Первое',
  );
  expect(await saved(page)).toMatchObject({ ...entry, anchor: 'word' });
  await page.getByRole('button', { name: /слов\/мин/ }).click();
  await page.getByRole('spinbutton', { name: 'Слов в минуту' }).fill('900');
  await page
    .getByRole('button', { name: 'Применить настройки', exact: true })
    .click();
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await expect(
    page.getByText('Книга закончилась', { exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await expect(page.getByLabel('Текущее слово', { exact: true })).toHaveText(
    'восьмое.',
  );
  await page.screenshot({
    path: test.info().outputPath('rsvp-end.png'),
    scale: 'css',
  });
  const end = await saved(page);
  expect(end?.spineIndex).toBe(1);
  await page.getByRole('button', { name: 'К тексту', exact: true }).click();
  await expect(page.locator('.speed-word-highlight').first()).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Режимы', exact: true }),
  ).toBeVisible();
  expect(await saved(page)).toEqual(end);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Режимы' })).toBeEnabled({
    timeout: 20000,
  });
  expect(await saved(page)).toEqual(end);
  expect(errors).toEqual([]);
});
test('Guided: окно слов, видимая подсветка, касание и сворачивание сохраняют позицию', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await open(page, true);
  await mode(page, 'Guided');
  const mark = page.locator('.speed-word-highlight').first();
  await expect(mark).toBeVisible();
  const window = await page.locator('.reader-stage').boundingBox();
  const first = await mark.boundingBox();
  expect(
    first &&
      window &&
      Math.abs(first.y + first.height / 2 - window.y - window.height / 2),
  ).toBeLessThan(30);
  await page.screenshot({
    path: test.info().outputPath('guided-paused.png'),
    scale: 'css',
  });
  const start = await saved(page);
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await expect.poll(() => saved(page)).not.toEqual(start);
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Продолжить', exact: true }),
  ).toBeVisible();
  const paused = await saved(page);
  await page.waitForTimeout(600);
  expect(await saved(page)).toEqual(paused);
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(
    page.getByRole('button', { name: 'Продолжить', exact: true }),
  ).toBeVisible();
  const hidden = await saved(page);
  await page.waitForTimeout(600);
  expect(await saved(page)).toEqual(hidden);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.getByRole('button', { name: 'К тексту', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Режимы', exact: true }),
  ).toBeVisible();
  expect(await saved(page)).toEqual(hidden);
  await mode(page, 'Guided');
  await page.getByRole('button', { name: /слов\/мин/ }).click();
  await page.getByRole('spinbutton', { name: 'Слов в минуту' }).fill('900');
  for (let index = 0; index < 9; index++)
    await page.getByRole('button', { name: 'Больше слов' }).click();
  await page
    .getByRole('button', { name: 'Применить настройки', exact: true })
    .click();
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await expect(
    page.getByText('Книга закончилась', { exact: true }),
  ).toBeVisible({ timeout: 20000 });
  expect((await saved(page))?.spineIndex).toBe(1);
  await expect(page.locator('.speed-word-highlight').first()).toBeVisible();
  await page.getByRole('button', { name: 'К тексту', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Режимы', exact: true }),
  ).toBeVisible();

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
