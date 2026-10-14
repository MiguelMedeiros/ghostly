// This language's area files, as one chunk the app loads when a profile reads in it (../index.ts).
export default import.meta.glob<unknown>("./*.json", { eager: true, import: "default" });
