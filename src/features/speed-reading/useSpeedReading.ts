import { useEffect, useMemo, useState } from 'react';
import type { ReaderLocation, ReaderSession } from '../../domain/reader';
import type { LocalStore } from '../../domain/repositories';
import type { ReadingCursor } from '../../domain/text-position';
import type { SpeedMode } from '../../services/speed-reading';
import {
  initialSpeedSnapshot,
  SpeedReadingService,
  type SpeedSnapshot,
} from '../../services/speed-reading';

export function useSpeedReading(
  reader: ReaderSession | null,
  store: LocalStore,
  onPosition: (location: ReaderLocation) => Promise<void>,
  onActive: (active: boolean) => void,
  onSnapshot?: (snapshot: SpeedSnapshot) => void,
  onCompleted?: (
    mode: SpeedMode,
    start: ReadingCursor,
    end: ReadingCursor,
  ) => void,
) {
  const [state, setState] = useState<{
    reader: ReaderSession | null;
    snapshot: SpeedSnapshot;
  }>(() => ({ reader: null, snapshot: initialSpeedSnapshot() }));
  const service = useMemo(
    () =>
      reader
        ? new SpeedReadingService(
            reader,
            store,
            onPosition,
            (snapshot) => {
              onActive(snapshot.active);
              onSnapshot?.(snapshot);
              setState({ reader, snapshot });
            },
            onCompleted,
          )
        : null,
    [reader, store, onPosition, onActive, onSnapshot, onCompleted],
  );
  useEffect(() => {
    const hide = () => {
      service?.pause();
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') hide();
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', hide);
    window.addEventListener('blur', hide);
    document.addEventListener('freeze', hide);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('blur', hide);
      document.removeEventListener('freeze', hide);
      service?.destroy();
      onActive(false);
    };
  }, [service, onActive]);
  const run = (action: (session: SpeedReadingService) => Promise<void>) => {
    if (service)
      void action(service).catch((reason: unknown) => {
        service.reportError(reason);
      });
  };
  return {
    snapshot: state.reader === reader ? state.snapshot : initialSpeedSnapshot(),
    service,
    run,
  };
}
