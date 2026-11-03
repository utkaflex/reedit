import 'jszip';
declare module 'jszip' {
  interface JSZipObject {
    /** Public JSZip API missing from its bundled declaration file. */
    internalStream(type: 'uint8array'): JSZipStreamHelper<Uint8Array>;
  }
}
