// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useBlobUrl } from '../src/ui/useBlobUrl';

it('shares a cover URL and releases it only after the final subscriber leaves', async () => {
  const create = vi.fn(() => 'blob:synthetic-cover');
  const revoke = vi.fn();
  const previousCreate = Object.getOwnPropertyDescriptor(
    URL,
    'createObjectURL',
  );
  const previousRevoke = Object.getOwnPropertyDescriptor(
    URL,
    'revokeObjectURL',
  );
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: create,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: revoke,
  });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const blob = new Blob(['cover']);
  const host = document.createElement('div');
  const root = createRoot(host);
  function Cover() {
    return createElement('span', null, useBlobUrl(blob));
  }
  try {
    await act(async () => {
      await Promise.resolve();
      root.render(
        createElement(
          'div',
          null,
          createElement(Cover, { key: 'a' }),
          createElement(Cover, { key: 'b' }),
        ),
      );
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(host.textContent).toBe('blob:synthetic-coverblob:synthetic-cover');
    await act(async () => {
      await Promise.resolve();
      root.render(
        createElement('div', null, createElement(Cover, { key: 'b' })),
      );
    });
    expect(revoke).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:synthetic-cover');
  } finally {
    if (previousCreate)
      Object.defineProperty(URL, 'createObjectURL', previousCreate);
    else Reflect.deleteProperty(URL, 'createObjectURL');
    if (previousRevoke)
      Object.defineProperty(URL, 'revokeObjectURL', previousRevoke);
    else Reflect.deleteProperty(URL, 'revokeObjectURL');
    vi.unstubAllGlobals();
  }
});
