// The translation runtime's stdio protocol, without the engine: runtime.mjs runs it under Bare with the Bergamot addon,
// the tests with a fake one. One JSON line per request, answered in order by one JSON line:
//   { id, op: "load", pair }              -> { id }
//   { id, op: "translate", pair, texts }  -> { id, texts }  (the pair is loaded first when it is not)
//   { id, op: "unload", pair? }           -> { id }         (every pair without one)
// or { id, error } for any of them. A pair is "<from>-<to>" in ISO 639 codes; one with English on neither side pivots
// through it (es-pt reads es-en and en-pt). The runtime never fetches: the app downloads and checks the files, into
// <models>/<from>-<to>/ under the folder it starts the runtime with.

/** The longest request line read (and the longest answer written): 30 messages of 4 000 characters, JSON-escaped. */
export const MAX_LINE = 1024 * 1024
export const MAX_TEXTS = 64
/** Loaded models kept at once (about 245 MB each): the least recently used is unloaded for a third. */
export const MAX_MODELS = 2

const LANG = /^[a-z]{2,3}$/
const CJK = ['ja', 'ko', 'zh']

/** `{ from, to }` of a pair name, or null when it is not one. */
export function parsePair(pair) {
  if (typeof pair !== 'string') return null
  const [from, to, extra] = pair.split('-')
  if (extra !== undefined || !LANG.test(from ?? '') || !LANG.test(to ?? '') || from === to) return null
  return { from, to }
}

/**
 * The files one direct model reads, by Mozilla's names: a CJK target has a vocabulary per side, every other pair (a
 * CJK source into English included) one shared vocabulary.
 */
export function modelFiles(from, to) {
  const pair = `${from}${to}`
  const split = CJK.includes(to)
  return {
    model: `model.${pair}.intgemm.alphas.bin`,
    srcVocab: split ? `srcvocab.${pair}.spm` : `vocab.${pair}.spm`,
    dstVocab: split ? `trgvocab.${pair}.spm` : `vocab.${pair}.spm`,
  }
}

/** The addon's `files` for a pair, under `root`: one model, or two chained through English. */
export function pairFiles(root, { from, to }, join) {
  const direct = (a, b) => {
    const names = modelFiles(a, b)
    const dir = join(root, `${a}-${b}`)
    return { model: join(dir, names.model), srcVocab: join(dir, names.srcVocab), dstVocab: join(dir, names.dstVocab) }
  }
  if (from === 'en' || to === 'en') return direct(from, to)
  const first = direct(from, 'en')
  const second = direct('en', to)
  return { ...first, pivotModel: second.model, pivotSrcVocab: second.srcVocab, pivotDstVocab: second.dstVocab }
}

const fail = (id, error) => ({ id, error })

/**
 * The protocol over an engine: `open({ from, to, files })` resolves to `{ translate(texts), close() }`.
 * `exists(path)` and `join(...parts)` are the platform's. Returns `handle(line)`, which answers one request line;
 * requests run one at a time, in the order they came.
 */
export function createRuntime({ root, open, exists, join }) {
  /** pair -> the opened model's promise, least recently used first. */
  const models = new Map()
  let queue = Promise.resolve()

  async function close(pair) {
    const model = models.get(pair)
    models.delete(pair)
    try { await (await model).close() } catch { /* failed to open: nothing to close */ }
  }

  async function load(name, pair) {
    const loaded = models.get(name)
    if (loaded) {
      models.delete(name)
      models.set(name, loaded)
      return loaded
    }
    const files = pairFiles(root, pair, join)
    if (!Object.values(files).every(path => exists(path))) throw new Error('Translation model not downloaded')
    while (models.size >= MAX_MODELS) await close(models.keys().next().value)
    const opening = open({ ...pair, files })
    models.set(name, opening)
    try { return await opening } catch (error) { models.delete(name); throw error }
  }

  async function run(request) {
    const { id, op } = request
    if (op === 'unload') {
      if (request.pair === undefined) { for (const pair of [...models.keys()]) await close(pair) }
      else if (models.has(request.pair)) await close(request.pair)
      return { id }
    }
    const pair = parsePair(request.pair)
    if (!pair) return fail(id, 'Unknown language pair')
    if (op === 'load') { await load(request.pair, pair); return { id } }
    if (op !== 'translate') return fail(id, 'Unknown request')
    const { texts } = request
    if (!Array.isArray(texts) || texts.length > MAX_TEXTS || !texts.every(text => typeof text === 'string')) return fail(id, 'Invalid texts')
    if (texts.length === 0) return { id, texts: [] }
    const model = await load(request.pair, pair)
    const out = await model.translate(texts)
    if (!Array.isArray(out) || out.length !== texts.length) return fail(id, 'Translation failed')
    return { id, texts: out.map(String) }
  }

  // The answer never carries a message's text in an error: only what the runtime itself says.
  async function answer(line) {
    let request
    try { request = JSON.parse(line) } catch { return fail(null, 'Invalid request') }
    if (request === null || typeof request !== 'object' || Array.isArray(request)) return fail(null, 'Invalid request')
    const id = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null
    if (id === null) return fail(null, 'Invalid request')
    try { return await run({ ...request, id }) } catch (error) {
      return fail(id, error instanceof Error && error.message === 'Translation model not downloaded' ? error.message : 'Translation failed')
    }
  }

  const enqueue = work => {
    const next = queue.then(work)
    queue = next.then(() => undefined, () => undefined)
    return next
  }

  return {
    handle: line => enqueue(() => answer(line)),
    /** The answer to a line lineReader dropped as too long, in its place among the others. */
    tooLong: () => enqueue(() => fail(null, 'Request too long')),
    /** Unloads every model (the input ended). */
    async close() { await queue; for (const pair of [...models.keys()]) await close(pair) },
  }
}

/**
 * Splits a byte stream's chunks into lines, decoded once whole (a character split between two chunks stays one). A
 * line longer than MAX_LINE bytes is not kept: `onTooLong()` hears it once, and the bytes up to its end are dropped.
 * Bare has no TextDecoder; it has Buffer, as Node does.
 */
export function lineReader(onLine, onTooLong) {
  let parts = []
  let size = 0
  let skipping = false
  return chunk => {
    let start = 0
    for (let at = chunk.indexOf(10); at >= 0; at = chunk.indexOf(10, start)) {
      const piece = chunk.subarray(start, at)
      start = at + 1
      if (skipping || size + piece.length > MAX_LINE) {
        if (!skipping) onTooLong()
        skipping = false
      } else {
        const text = Buffer.concat([...parts, piece]).toString('utf8')
        if (text.trim()) onLine(text)
      }
      parts = []
      size = 0
    }
    if (skipping) return
    const rest = chunk.subarray(start)
    if (size + rest.length > MAX_LINE) { onTooLong(); skipping = true; parts = []; size = 0; return }
    if (rest.length) { parts.push(Buffer.from(rest)); size += rest.length }
  }
}
