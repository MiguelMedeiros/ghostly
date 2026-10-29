// DEBUG build of the translation runtime (not for merge): stdio through bare-fs on fds 0/1 instead of bare-pipe.
const T0 = Date.now()
const trace = what => console.error(`[trace ${Date.now() - T0} ms] ${what}`)
trace('body start')
const { default: fs } = await import('bare-fs')
const { default: path } = await import('bare-path')
const { createRuntime, lineReader } = await import('./protocol.mjs')
trace('importing the addon')
const { default: TranslationNmtcpp } = await import('@qvac/translation-nmtcpp')
trace(`addon imported, argv=${JSON.stringify(Bare.argv)}`)
setInterval(() => trace('alive'), 15000)
const root = Bare.argv[2]
if (!root || !path.isAbsolute(root)) {
  console.error('Usage: bare runtime.mjs <absolute models folder>')
  Bare.exit(2)
}

console.log = console.info = console.debug = (...args) => console.error(...args)
const quiet = { error() {}, warn() {}, info() {}, debug() {} }

async function open({ from, to, files }) {
  const model = new TranslationNmtcpp({
    files,
    params: { srcLang: from, dstLang: to },
    config: { modelType: TranslationNmtcpp.ModelTypes.Bergamot, beamsize: 1, normalize: 1, ...(files.pivotModel ? { pivotConfig: { beamsize: 1 } } : {}) },
    logger: quiet,
  })
  trace('load start')
  await model.load()
  trace('load done')
  return { translate: async texts => { trace('runBatch start'); const r = await model.runBatch(texts); trace('runBatch done'); return r }, close: () => model.destroy() }
}

const exists = file => { try { return fs.statSync(file).isFile() } catch { return false } }
const runtime = createRuntime({ root, open, exists, join: path.join })
const write = answer => {
  trace('write')
  const bytes = Buffer.from(JSON.stringify(answer) + '\n')
  for (let at = 0; at < bytes.byteLength;) at += fs.writeSync(1, bytes, at, bytes.byteLength - at)
  trace('written')
}
const onData = lineReader(line => { runtime.handle(line).then(write) }, () => { runtime.tooLong().then(write) })
const chunk = Buffer.alloc(64 * 1024)
const pump = async () => {
  for (;;) {
    let read
    try { read = await fs.read(0, chunk, 0, chunk.byteLength, -1) } catch (error) { trace('stdin error ' + error.message); read = 0 }
    if (read === 0) break
    trace('stdin data ' + read)
    onData(Buffer.from(chunk.subarray(0, read)))
  }
  trace('stdin end')
  runtime.close().finally(() => Bare.exit(0))
}
pump()
trace('listening')
