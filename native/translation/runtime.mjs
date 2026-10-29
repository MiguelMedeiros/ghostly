// The translation runtime, run by `bare runtime.mjs <models folder>`: the stdio protocol of protocol.mjs over QVAC's
// Bergamot addon. Started by the app, not listening on any port, and it never fetches: the only files it reads are the
// models under the folder it was given, by fixed names. Nothing it writes carries a message's text but the answers.
const T0 = Date.now()
console.error('[trace console] body start')
const { default: process } = await import('bare-process')
console.error('[trace console] bare-process imported')
const trace = what => { try { process.stderr.write(`[trace ${Date.now() - T0} ms] ${what}\n`) } catch {} }
trace('stderr via bare-process works')
const { default: fs } = await import('bare-fs')
const { default: path } = await import('bare-path')
const { createRuntime, lineReader } = await import('./protocol.mjs')
trace('importing the addon')
const { default: TranslationNmtcpp } = await import('@qvac/translation-nmtcpp')
trace(`started argv=${JSON.stringify(Bare.argv)} stdin=${process.stdin?.constructor?.name} stdout=${process.stdout?.constructor?.name}`)
setInterval(() => trace('alive'), 15000)
const root = Bare.argv[2]
if (!root || !path.isAbsolute(root)) {
  process.stderr.write('Usage: bare runtime.mjs <absolute models folder>\n')
  Bare.exit(2)
}

// stdout carries the protocol only: a library's console.log goes to stderr.
console.log = console.info = console.debug = (...args) => console.error(...args)
const quiet = { error() {}, warn() {}, info() {}, debug() {} }

async function open({ from, to, files }) {
  const model = new TranslationNmtcpp({
    files,
    params: { srcLang: from, dstLang: to },
    config: { modelType: TranslationNmtcpp.ModelTypes.Bergamot, beamsize: 1, normalize: 1, ...(files.pivotModel ? { pivotConfig: { beamsize: 1 } } : {}) },
    logger: quiet,
  })
  trace('load start ' + JSON.stringify(files))
  await model.load()
  trace('load done')
  return { translate: async texts => { trace('runBatch start'); const r = await model.runBatch(texts); trace('runBatch done'); return r }, close: () => model.destroy() }
}

const exists = file => { try { return fs.statSync(file).isFile() } catch { return false } }
const runtime = createRuntime({ root, open, exists, join: path.join })
const write = answer => { trace('write ' + JSON.stringify(answer).length + ' chars'); process.stdout.write(JSON.stringify(answer) + '\n') }
process.stdin.on('data', chunk => trace('stdin data ' + chunk.length))
trace('listening')
process.stdin.on('data', lineReader(line => { runtime.handle(line).then(write) }, () => { runtime.tooLong().then(write) }))
// The app closed our input: it is done with us.
process.stdin.on('end', () => { runtime.close().finally(() => Bare.exit(0)) })
