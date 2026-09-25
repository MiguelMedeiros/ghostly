/**
 * Stands in for `@ghostly/iroh-web` in the desktop build (vite.config.ts). Desktop runs Iroh natively
 * (src/desktop/nativeTransports.ts) and never sets the engine's `irohWeb`, so the browser build of Iroh is
 * never loaded there; this keeps its 2.9 MB of wasm out of the app.
 */
const unavailable = () => { throw new Error("Iroh's browser build is not part of the desktop app"); };
export default async function init(): Promise<never> { return unavailable(); }
export const initSync = unavailable;
export const IrohNode = { start: unavailable };
