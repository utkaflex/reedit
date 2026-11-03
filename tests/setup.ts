import 'fake-indexeddb/auto';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
// Keep IndexedDB structuredClone and Dexie's captured Blob constructors in the same realm.
// XML/XHTML still use jsdom's inert DOMParser; these are real platform binary objects.
if (typeof window !== 'undefined') {
  Object.defineProperty(globalThis, 'Blob', {
    configurable: true,
    value: NodeBlob,
  });
  Object.defineProperty(window, 'Blob', {
    configurable: true,
    value: NodeBlob,
  });
  Object.defineProperty(globalThis, 'File', {
    configurable: true,
    value: NodeFile,
  });
  Object.defineProperty(window, 'File', {
    configurable: true,
    value: NodeFile,
  });
}
