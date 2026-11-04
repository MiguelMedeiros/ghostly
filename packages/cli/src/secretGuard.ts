/**
 * The app's secret guard (apps/ui/src/lib/parse/secrets.ts), with BIP39's lists in the app's other languages loaded
 * from the start: the web app loads them as its composer opens.
 */
import "../../../apps/ui/src/lib/parse/seedLists";

export { findSecret } from "../../../apps/ui/src/lib/parse/secrets";
