import { expect, test } from '@playwright/test';
import { securityHeaders } from '../../server/web';
import { makeEpubFixture } from '../fixtures/epub';

for (const scenario of [
  { version: '2', mode: 'paginated' },
  { version: '3', mode: 'paginated' },
  { version: '3', mode: 'scroll' },
] as const) {
  test(`XHTML iframe под production CSP: EPUB ${scenario.version}, ${scenario.mode}`, async ({
    page,
  }) => {
    test.setTimeout(45000);
    const fixture = await makeEpubFixture({
      cover: true,
      version: scenario.version,
    });
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.route('**/__reader-csp', (route) =>
      route.fulfill({
        body: '<!doctype html><html><head><title>Reader test</title></head><body></body></html>',
        contentType: 'text/html',
        headers: securityHeaders,
      }),
    );
    await page.goto('/__reader-csp');
    const result = await page.evaluate(
      async ({ bytes, mode }) => {
        const path = '/tests/fixtures/reader-probe.ts';
        const loaded: unknown = await import(path);
        return (
          loaded as typeof import('../fixtures/reader-probe')
        ).probeReader(bytes, mode);
      },
      { bytes: [...fixture.bytes], mode: scenario.mode },
    );
    expect(result, JSON.stringify({ result, errors })).toMatchObject({
      ready: true,
    });
  });
}
