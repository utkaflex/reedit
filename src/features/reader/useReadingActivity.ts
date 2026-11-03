import { useCallback, useEffect, useRef, useState } from 'react';
import type { LocalStore } from '../../domain/repositories';
import type { ReaderLocation } from '../../domain/reader';
import type {
  DocumentTextIndex,
  ReadingCursor,
} from '../../domain/text-position';
import {
  WordLocator,
  activityMode,
  type ReadingMode,
  type WordInterval,
} from '../../domain/statistics';
import type { ReaderAddress } from '../../services/reader';
import { ReadingActivityService } from '../../services/reading-activity';
import type { SpeedSnapshot } from '../../services/speed-reading';

export function useReadingActivity(store: LocalStore, address: ReaderAddress) {
  const service = useRef<ReadingActivityService | null>(null);
  const locator = useRef<WordLocator | null>(null);
  const latestLocation = useRef<ReaderLocation | null>(null);
  const view = useRef<{
    interval: WordInterval;
    dwell: number;
    confirmed: boolean;
  } | null>(null);
  const activeSpeed = useRef<{
    active: boolean;
    playing: boolean;
    mode: ReadingMode;
  }>({ active: false, playing: false, mode: 'ordinary' });
  const lastInteraction = useRef(0);
  const lastPulse = useRef(0);
  const [canConfirm, setCanConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mode = useCallback((): ReadingMode | null => {
    const speed = activeSpeed.current;
    return activityMode({
      visible: document.visibilityState !== 'hidden',
      modal: Boolean(document.querySelector('dialog[open]')),
      speedActive: speed.active,
      playing: speed.playing,
      mode: speed.mode,
      now: performance.now(),
      lastInteraction: lastInteraction.current,
    });
  }, []);
  const pulse = useCallback(() => {
    const now = performance.now(),
      elapsed = now - lastPulse.current;
    lastPulse.current = now;
    const currentMode = mode();
    const current = view.current;
    if (
      current &&
      currentMode === 'ordinary' &&
      elapsed >= 0 &&
      elapsed <= 2500
    )
      current.dwell += elapsed;
    setCanConfirm(
      Boolean(
        current &&
        !current.confirmed &&
        currentMode === 'ordinary' &&
        current.dwell >=
          Math.max(
            1500,
            ((current.interval.end - current.interval.start) * 60000) / 900,
          ),
      ),
    );
    void service.current?.pulse(currentMode).catch(() => undefined);
  }, [mode]);
  const interact = useCallback(() => {
    lastInteraction.current = performance.now();
  }, []);
  const attach = useCallback(
    async (index: DocumentTextIndex, signal: AbortSignal) => {
      const words = await WordLocator.create(index);
      if (signal.aborted) return;
      await service.current?.pause();
      locator.current = words;
      service.current = new ReadingActivityService(
        store,
        address.readingId,
        address.fileId,
        setError,
      );
      lastInteraction.current = performance.now();
      lastPulse.current = performance.now();
      const visible = latestLocation.current?.visible;
      const interval = visible
        ? words.interval(visible.start, visible.end)
        : null;
      view.current = interval ? { interval, dwell: 0, confirmed: false } : null;
      setCanConfirm(false);
      pulse();
    },
    [store, address, pulse],
  );
  const observe = useCallback((location: ReaderLocation) => {
    latestLocation.current = location;
    let interval: WordInterval | null = null;
    try {
      if (location.visible && locator.current)
        interval = locator.current.interval(
          location.visible.start,
          location.visible.end,
        );
    } catch {
      /* Unknown visible boundaries earn no words. */
    }
    if (
      interval?.start !== view.current?.interval.start ||
      interval?.end !== view.current?.interval.end
    ) {
      view.current = interval ? { interval, dwell: 0, confirmed: false } : null;
      setCanConfirm(false);
    }
  }, []);
  const speedState = useCallback(
    (snapshot: SpeedSnapshot) => {
      // Flush the old mode at the transition before assigning the new mode.
      pulse();
      activeSpeed.current = {
        active: snapshot.active,
        playing: snapshot.playing && !snapshot.preparing,
        mode: snapshot.mode,
      };
      pulse();
    },
    [pulse],
  );
  const completed = useCallback(
    (readingMode: ReadingMode, start: ReadingCursor, end: ReadingCursor) => {
      if (
        document.visibilityState === 'hidden' ||
        document.querySelector('dialog[open]')
      )
        return;
      try {
        const interval = locator.current?.interval(start, end);
        if (interval)
          void service.current
            ?.record(readingMode, interval)
            .catch(() => undefined);
      } catch {
        setError(
          'Не удалось сопоставить слово с индексом. Учёт слов приостановлен.',
        );
      }
    },
    [],
  );
  const confirm = useCallback(() => {
    const current = view.current;
    if (
      !current ||
      current.confirmed ||
      mode() !== 'ordinary' ||
      current.dwell <
        Math.max(
          1500,
          ((current.interval.end - current.interval.start) * 60000) / 900,
        )
    )
      return;
    current.confirmed = true;
    setCanConfirm(false);
    void service.current?.record('ordinary', current.interval).catch(() => {
      /* Pending UUID is retained for an idempotent retry. */
    });
  }, [mode]);
  useEffect(() => {
    const timer = window.setInterval(pulse, 1000);
    const pause = () => {
      lastPulse.current = performance.now();
      void service.current?.pause().catch(() => undefined);
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') pause();
      else {
        interact();
        pulse();
      }
    };
    window.addEventListener('pointerdown', interact, true);
    window.addEventListener('keydown', interact, true);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pause);
    document.addEventListener('freeze', pause);
    return () => {
      clearInterval(timer);
      window.removeEventListener('pointerdown', interact, true);
      window.removeEventListener('keydown', interact, true);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', pause);
      document.removeEventListener('freeze', pause);
      pause();
      service.current = null;
      locator.current = null;
    };
  }, [pulse, interact]);
  const flush = useCallback(async () => {
    await service.current?.pause();
    await service.current?.flush();
  }, []);
  return {
    attach,
    observe,
    interact,
    completed,
    speedState,
    confirm,
    canConfirm,
    error,
    flush,
  };
}
