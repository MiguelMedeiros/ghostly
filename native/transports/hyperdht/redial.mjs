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
 * The longest a stream that opened waits for the preface on a slow path: the 8 s a chat's move gives its dial. Past
 * it nobody is waiting for the dial made again, and UDX gives a silent stream up at 13 s anyway.
 */
export const PREFACE_MAX_WAIT_MS = 8000

/**
 * How many of the stream's smoothed round trips the preface may take. A contact that waits for our first packet
 * before its side of the stream connects (we are behind a firewall) writes its preface one round trip after our
 * stream opened; a lost packet adds a retransmission timeout (at least one round trip more). Three keep a slow path's
 * preface from being dialled again for nothing (a fixed 2 s on a 3 s path made three dials) and leave every path
 * under 667 ms on the 2 s.
 */
export const RTT_FACTOR = 3

/**
 * Before the stream has its first RTT sample, how many times the dial's own opening (from the dial to the stream
 * open) the preface may take. The handshake that opened the stream went to the contact and back through a DHT node,
 * so it took at least one round trip of the path; on a 3 s path the first sample comes only 3 s after the stream
 * opened, past the 2 s. A dial that opened in milliseconds (loopback, a near contact) stays on the 2 s.
 */
export const OPENING_FACTOR = 2

/**
 * The preface wait for a stream whose smoothed RTT is `rtt` ms and whose dial took `opening` ms to open: three round
 * trips once there is a sample, twice the opening before, between `floor` and `ceiling`.
 */
export function prefaceWait(rtt, opening = 0, floor = PREFACE_WAIT_MS, ceiling = PREFACE_MAX_WAIT_MS) {
  const wait = rtt > 0 ? RTT_FACTOR * rtt : OPENING_FACTOR * (opening || 0)
  return Math.min(ceiling, Math.max(floor, wait))
}

/**
 * At most this many dials for one `connect`: the first, and two more if they stalled, 2 s apart, all within the 8 s a
 * chat's move gives its dial. Under load a dial made again stalled too about once in 20 (bug hunt r11h).
 */
export const MAX_DIALS = 3

/**
 * Dials with `dialOnce` until one brings the contact's preface. `dialOnce()` starts a connection and returns
 * `{ opened, ready, close }`: `opened` resolves true once the stream is open (the handshake is done), `ready` with the
 * bound channel once the contact's preface came, and `close()` drops it; `rtt()`, if given, is the stream's smoothed
 * RTT in ms so far, 0 before its first sample (UDX's `rawStream.rtt`). A dial that opened and brought no preface
 * within `waitMs`, or longer on a slow path (`prefaceWait`, at most `maxWaitMs`), is closed and made again, up to
 * `maxDials` in all. The RTT is read again whenever the wait would end, so a sample taken after the stream opened
 * counts. A dial that fails before it opened (the contact not found, refused) fails the whole connect at once, as
 * before: there is nothing to wait for.
 */
export function redial(dialOnce, { waitMs = PREFACE_WAIT_MS, maxWaitMs = PREFACE_MAX_WAIT_MS, maxDials = MAX_DIALS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    let dials = 0
    const attempt = () => {
      dials++
      const dialledAt = Date.now()
      const dial = dialOnce()
      let timer = null
      let stalled = false
      dial.opened.then(open => {
        if (!open || settled) return
        const openedAt = Date.now()
        const check = () => {
          if (settled) return
          const left = openedAt + prefaceWait(dial.rtt?.(), openedAt - dialledAt, waitMs, maxWaitMs) - Date.now()
          if (left > 0) { timer = setTimeout(check, left); return }
          if (dials >= maxDials) return
          stalled = true
          dial.close()
          attempt()
        }
        timer = setTimeout(check, waitMs)
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
