/**
 * How long a HyperDHT dial whose stream opened may go without the contact's preface before it is dialled again.
 *
 * The first connection a freshly started process makes sometimes opens (the handshake went through the DHT and the
 * stream is connected to the right address) and then carries nothing: the contact never sees it, and UDX gives up
 * only after 13 s. A connection made again at once goes through in milliseconds. Found as a chat moved to HyperDHT
 * right after the contact's app restarted taking about 28 s in CI (the move's 8 s, then its 20 s retry), 1 run in 6;
 * reproduced with hyperdht alone under load (bug hunt r11h). On loopback the preface comes within milliseconds of
 * the stream opening, one round trip on the internet.
 */
export const PREFACE_WAIT_MS = 2000

/**
 * At most this many dials for one `connect`: the first, and two more if they stalled, 2 s apart, all within the 8 s a
 * chat's move gives its dial. Under load a dial made again stalled too about once in 20 (bug hunt r11h).
 */
export const MAX_DIALS = 3

/**
 * Dials with `dialOnce` until one brings the contact's preface. `dialOnce()` starts a connection and returns
 * `{ opened, ready, close }`: `opened` resolves true once the stream is open (the handshake is done), `ready` with the
 * bound channel once the contact's preface came, and `close()` drops it. A dial that opened and brought no preface
 * within `waitMs` is closed and made again, up to `maxDials` in all. A dial that fails before it opened (the contact
 * not found, refused) fails the whole connect at once, as before: there is nothing to wait for.
 */
export function redial(dialOnce, { waitMs = PREFACE_WAIT_MS, maxDials = MAX_DIALS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    let dials = 0
    const attempt = () => {
      dials++
      const dial = dialOnce()
      let timer = null
      let stalled = false
      dial.opened.then(open => {
        if (!open || settled) return
        timer = setTimeout(() => {
          if (settled || dials >= maxDials) return
          stalled = true
          dial.close()
          attempt()
        }, waitMs)
      }, () => {})
      dial.ready.then(bound => {
        clearTimeout(timer)
        if (settled || stalled) { bound.channel.close(); return }
        settled = true
        resolve(bound)
      }, error => {
        clearTimeout(timer)
        // A dial closed here for stalling ends as closed: the next one carries the connect.
        if (settled || stalled) return
        settled = true
        reject(error)
      })
    }
    attempt()
  })
}
