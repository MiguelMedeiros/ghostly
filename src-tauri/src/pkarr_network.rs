//! Pkarr as Ghostly Desktop reaches it: the Mainline DHT and the public relays.
//!
//! A packet is published to both. Reading is where the two differ: a relay
//! hands over the copy it holds in about 0.3 s, a DHT lookup takes 2.5 s or
//! more, and the peer polls every second or two while it waits for a signal.
//! So a read asks one relay and returns, while a DHT lookup for the same key
//! runs on in the background. Every packet either finds is kept as that key's
//! newest (signatures verified by pkarr, the newest timestamp wins), and a read
//! returns the newest seen: one that a peer put only on the DHT is at most one
//! poll late.
//!
//! Publishing is timed the same way. A relay keeps a packet the moment the PUT
//! arrives and serves it from then on, but answers only after its own DHT put,
//! seconds later, and the DHT put from here takes 2 to 6 s. A link publishes
//! several times while pairing (its presence, its offer, its answer), one after
//! the other, so waiting for those answers put seconds between each step. Now a
//! publish returns as soon as the packet can be read back from a relay, or a
//! write succeeded, whichever is first; the writes run on in the background and
//! say in the log how they ended.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use pkarr::{Client, PublicKey, ResolvePolicy, SignedPacket};
use tokio::sync::watch;
use url::Url;

use crate::diagnostics;

/// Reads this client allows itself per relay and minute; past it, a read
/// returns the newest seen and leaves the relays to the DHT lookup. Relays
/// limit by IP (120 requests a minute when this was written). Writes are not
/// counted, nor held back, as before: the lookup this replaced asked both
/// relays on every read, some 45 requests a minute per relay while a link was
/// being set up, and a peer setting one up publishes about as often again.
const READS_PER_MINUTE: usize = 40;
/// A relay that answered 429 or could not be reached is left alone this long.
const REST: Duration = Duration::from_secs(15);
/// Keys whose newest packet is remembered; the least recently read go first.
const REMEMBERED_KEYS: usize = 1024;
/// A relay that has the packet answers in 0.3 s (0.9 s while a PUT for the key
/// is landing); one that has not asks its DHT first and takes longer than a
/// poll should. A read waits this long for a relay, and no longer.
const READ_TIMEOUT: Duration = Duration::from_millis(1_500);
/// A relay answers a PUT after its own DHT put: this long is given to hear how it went.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// After a relay answered empty-handed, how much longer a read waits for the DHT lookup before
/// returning nothing; the lookup runs on, and the next poll has what it found.
const LOOKUP_GRACE: Duration = Duration::from_millis(300);
/// A background read (nobody waiting on it) spends no relay budget and waits for the lookup this long.
const BACKGROUND_LOOKUP_WAIT: Duration = Duration::from_secs(4);
/// A publish reads its packet back from a relay this soon after the PUTs left, then every so often…
const READ_BACK_AFTER: Duration = Duration::from_millis(200);
const READ_BACK_EVERY: Duration = Duration::from_millis(300);
/// …this many times at most; after that it waits for the writes themselves.
const READ_BACKS: usize = 4;
/// A relay that says (`x-ratelimit-remaining`) it has fewer requests left than this for us is left
/// to the others; pkarr.pubky.org allows 50 a minute per address, pkarr.pubky.app 1000.
const RESERVE: i64 = 4;
/// A second opinion on an urgent read is asked of a relay only while it has this many left.
const SECOND_OPINION_RESERVE: i64 = 12;
/// Once a relay said its limit (`x-ratelimit-limit`, a minute's worth per address), this client
/// allows itself half of it, within these bounds: two apps on one machine share the address.
const READS_PER_MINUTE_LEAST: usize = 10;
const READS_PER_MINUTE_MOST: usize = 90;
/// A read-back after a publish waits this long for the relay: one that has the packet answers in
/// 0.3 s; one that has not is still asking its DHT, and the next read-back will do.
const READ_BACK_TIMEOUT: Duration = Duration::from_millis(700);
/// A relay's body, at most: a packet is 1104 bytes, with room for the odd header the relay adds.
const MAX_BODY: usize = 4096;
/// A first PUT of ours to a relay that answers 409 (it is still putting the packet this key was warmed
/// with, which takes it 3-5 s) is tried again this often, this many times: the packet lands the moment
/// the relay is done, and is served from then on.
const FIRST_PUT_RETRIES: usize = 7;
const FIRST_PUT_RETRY_AFTER: Duration = Duration::from_millis(700);

pub struct Pkarr {
    inner: Arc<Inner>,
}

struct Inner {
    /// Publishes, and looks keys up in the background. The DHT in the app.
    lookup: Option<Client>,
    /// The relays, read and written with plain HTTP (`READ_TIMEOUT` / `WRITE_TIMEOUT`, `If-Match` on
    /// writes, the relay's rate-limit headers read on every answer).
    relays: Vec<Url>,
    http: reqwest::Client,
    /// READS_PER_MINUTE for the public relays; none for relays of one's own.
    reads_per_minute: usize,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    newest: HashMap<PublicKey, Seen>,
    /// Lookups in flight, one per key: a poll never starts a second.
    lookups: HashMap<PublicKey, watch::Receiver<bool>>,
    relays: Vec<RelayBudget>,
    turn: usize,
}

struct Seen {
    packet: SignedPacket,
    read_at: Instant,
}

#[derive(Default)]
struct RelayBudget {
    spent: VecDeque<Instant>,
    resting_until: Option<Instant>,
    /// What the relay last said it has left for this address (`x-ratelimit-remaining`), if it says.
    remaining: Option<i64>,
    /// The relay's own limit per minute (`x-ratelimit-limit`), if it says: this client's cap follows it.
    limit: Option<usize>,
    /// The timestamp of the last packet this client PUT there, per key: what the next PUT replaces.
    last_put: HashMap<PublicKey, pkarr::Timestamp>,
}

/// What a relay answered a GET with.
enum RelayAnswer {
    Packet(SignedPacket),
    Missing,
    RateLimited,
    Timeout,
    Unreachable(String),
    Other(String),
}

/// One write of a packet, to a relay or the DHT, and how it went.
type Write = std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>>;

fn short(key: &PublicKey) -> String {
    key.to_z32().chars().take(6).collect()
}

/// An error, in a few words, for a log line.
fn brief(error: &str) -> String {
    let first = error.split(':').next().unwrap_or(error).trim();
    first.chars().take(40).collect()
}

impl Pkarr {
    /// The app's: the DHT, and pkarr's default relays for reads and writes —
    /// or, when `GHOSTLY_PKARR_RELAYS` names some (comma-separated URLs), those
    /// relays alone: a private network, or the end-to-end tests' relay, which
    /// is how the scenario matrix pairs Desktop with its other peers offline.
    pub fn desktop() -> Result<Self, String> {
        if let Some(relays) = private_relays(std::env::var("GHOSTLY_PKARR_RELAYS").ok().as_deref())?
        {
            return Self::private(&relays);
        }
        let mut dht = Client::builder();
        dht.no_relays().cache_size(50);
        let dht = dht.build().map_err(|e| format!("Pkarr client: {e}"))?;
        let relays = pkarr::DEFAULT_RELAYS.map(|url| url.parse().expect("pkarr's relay URLs"));
        Self::new(Some(dht), &relays)
    }

    /// Relays of one's own and nothing else: no DHT, and no read budget, since
    /// the budget is there for the public relays' limits.
    pub fn private(relays: &[Url]) -> Result<Self, String> {
        Self::with_budget(None, relays, usize::MAX)
    }

    /// `lookup` is the slow, complete source (the DHT); `relays` the fast one.
    pub fn new(lookup: Option<Client>, relays: &[Url]) -> Result<Self, String> {
        Self::with_budget(lookup, relays, READS_PER_MINUTE)
    }

    fn with_budget(
        lookup: Option<Client>,
        relays: &[Url],
        reads_per_minute: usize,
    ) -> Result<Self, String> {
        // One HTTP client for every relay: connections are kept and reused.
        let http = reqwest::Client::builder()
            .build()
            .map_err(|e| format!("HTTP client: {e}"))?;
        let state = State {
            relays: relays.iter().map(|_| RelayBudget::default()).collect(),
            ..State::default()
        };
        Ok(Self {
            inner: Arc::new(Inner {
                lookup,
                relays: relays.to_vec(),
                http,
                reads_per_minute,
                state: Mutex::new(state),
            }),
        })
    }

    /// Publishes to the DHT and every relay. Returns once the packet is out there to be read: a relay
    /// serves it back, or a write succeeded. The writes run on and log how they ended; an error means
    /// every one of them failed.
    pub async fn publish(&self, packet: &SignedPacket) -> Result<(), String> {
        let started = Instant::now();
        let key = packet.public_key();
        let inner = self.inner.clone();
        // `outcome`: `None` while writes run, then whether any succeeded; `first_ok`: the first success.
        let (outcome_tx, mut outcome) = watch::channel::<Option<Result<(), String>>>(None);
        let (first_ok_tx, mut first_ok) = watch::channel(false);
        let writes: Vec<(String, Write)> = (0..inner.relays.len())
            .map(|index| {
                let (this, packet) = (
                    Self {
                        inner: inner.clone(),
                    },
                    packet.clone(),
                );
                (
                    inner.relays[index]
                        .host_str()
                        .unwrap_or("relay")
                        .to_string(),
                    Box::pin(async move { this.relay_put(index, &packet).await }) as _,
                )
            })
            .chain(inner.lookup.clone().map(|client| {
                let packet = packet.clone();
                (
                    "dht".to_string(),
                    Box::pin(async move {
                        client
                            .publish(&packet)
                            .await
                            .map(|_| ())
                            .map_err(|e| e.to_string())
                    }) as _,
                )
            }))
            .collect();
        {
            let (key, first_ok_tx) = (key.clone(), first_ok_tx.clone());
            tokio::spawn(async move {
                let mut errors = Vec::new();
                let mut ok = false;
                let mut report = Vec::new();
                let mut pending = writes
                    .into_iter()
                    .map(|(name, write)| async move { (name, write.await) })
                    .collect::<futures_util::stream::FuturesUnordered<_>>();
                use futures_util::StreamExt;
                while let Some((name, result)) = pending.next().await {
                    let at = started.elapsed().as_millis();
                    match result {
                        Ok(()) => {
                            ok = true;
                            let _ = first_ok_tx.send(true);
                            report.push(format!("{name}=ok@{at}ms"));
                        }
                        Err(e) => {
                            report.push(format!("{name}=err@{at}ms({})", brief(&e)));
                            errors.push(format!("{name}: {e}"));
                        }
                    }
                }
                diagnostics::log(&format!(
                    "pkarr publish {} done {}",
                    short(&key),
                    report.join(" ")
                ));
                let _ = outcome_tx.send(Some(if ok {
                    Ok(())
                } else {
                    Err(format!("Publish error: {}", errors.join("; ")))
                }));
            });
        }
        // Our own newest: a read of this key from here (a read-back) compares against it.
        let wanted = packet.timestamp();
        let settled = async {
            // An error here means the write task is gone, which counts as settled.
            let _ = outcome.wait_for(|o| o.is_some()).await;
            outcome
                .borrow()
                .clone()
                .unwrap_or_else(|| Err("Publish error: writes vanished".into()))
        };
        tokio::pin!(settled);
        let mut wait = READ_BACK_AFTER;
        for _ in 0..READ_BACKS {
            tokio::select! {
                result = &mut settled => return self.published(&key, started, "settled", result),
                _ = async { let _ = first_ok.wait_for(|ok| *ok).await; } => return self.published(&key, started, "written", Ok(())),
                _ = tokio::time::sleep(wait) => {}
            }
            wait = READ_BACK_EVERY;
            // A read-back is not a poll: it spends none of the read budget (the relay counts it all the same).
            let Some(index) = self.pick_relay(false) else {
                continue;
            };
            let read = self.relay_get_within(index, &key, READ_BACK_TIMEOUT);
            tokio::pin!(read);
            tokio::select! {
                result = &mut settled => return self.published(&key, started, "settled", result),
                _ = async { let _ = first_ok.wait_for(|ok| *ok).await; } => return self.published(&key, started, "written", Ok(())),
                answer = &mut read => {
                    let visible = matches!(&answer, RelayAnswer::Packet(seen) if seen.timestamp() >= wanted);
                    self.relay_answered(index, answer);
                    if visible { return self.published(&key, started, "visible", Ok(())); }
                }
            }
        }
        let result = settled.await;
        self.published(&key, started, "settled late", result)
    }

    fn published(
        &self,
        key: &PublicKey,
        started: Instant,
        how: &str,
        result: Result<(), String>,
    ) -> Result<(), String> {
        diagnostics::log(&format!(
            "pkarr publish {} {how} after {}ms{}",
            short(key),
            started.elapsed().as_millis(),
            result
                .as_ref()
                .err()
                .map(|e| format!(" {e}"))
                .unwrap_or_default()
        ));
        result
    }

    /// The newest packet seen under `key`, having asked the network: `None`
    /// when nobody has published one anyone could find.
    pub async fn resolve(&self, key: &PublicKey) -> Option<SignedPacket> {
        self.resolve_with(key, false, false).await
    }

    /// `background`: a look that can wait (a link nobody is watching, nothing expected). It asks no
    /// relay, keeping their budget for links that are signaling, and waits for the DHT lookup instead.
    /// A foreground read asks one relay and returns what is known the moment the relay answered (or
    /// `READ_TIMEOUT` passed): a key nobody has yet costs one read, not the DHT lookup's seconds too.
    /// `urgent`: a signal is due any moment; when the relay asked had nothing newer, a second relay
    /// with plenty of requests left is asked too (relays do not all serve a fresh packet at once).
    pub async fn resolve_with(
        &self,
        key: &PublicKey,
        background: bool,
        urgent: bool,
    ) -> Option<SignedPacket> {
        let started = Instant::now();
        let before = self.newest(key).map(|p| p.timestamp());
        let lookup = self.look_up(key);
        let source;

        if background {
            if self.newest(key).is_none() {
                if let Some(done) = lookup {
                    let _ = tokio::time::timeout(BACKGROUND_LOOKUP_WAIT, finished(done)).await;
                }
            }
            source = "dht";
        } else if let Some(index) = self.pick_relay(true) {
            let read = self.relay_get(index, key);
            tokio::pin!(read);
            let answer = match lookup.clone() {
                Some(done) => tokio::select! {
                    answer = &mut read => Some(answer),
                    _ = finished(done) => None,
                },
                None => Some(read.as_mut().await),
            };
            source = match answer {
                Some(answer) => {
                    let source = match &answer {
                        RelayAnswer::Packet(_) => "relay",
                        RelayAnswer::Missing => "relay-miss",
                        RelayAnswer::Timeout => "relay-timeout",
                        RelayAnswer::RateLimited => "relay-429",
                        RelayAnswer::Unreachable(_) => "relay-down",
                        RelayAnswer::Other(_) => "relay-error",
                    };
                    self.relay_answered(index, answer);
                    source
                }
                // The lookup was quicker. Only an empty handed one waits for the relay.
                None if self.newest(key).is_none() => {
                    self.relay_answered(index, read.await);
                    "relay-late"
                }
                None => "dht",
            };
            // Nothing newer from that relay, and a signal is due: another relay may have it already.
            if urgent && self.newest(key).map(|p| p.timestamp()) == before {
                if let Some(other) = self.pick_relay_other_than(index) {
                    let answer = self.relay_get(other, key).await;
                    self.relay_answered(other, answer);
                }
            }
            if self.newest(key).is_none() {
                if let Some(done) = lookup {
                    let _ = tokio::time::timeout(LOOKUP_GRACE, finished(done)).await;
                }
            }
        } else if self.newest(key).is_none() {
            // No relay budget left: the lookup is all there is.
            if let Some(done) = lookup {
                let _ = tokio::time::timeout(BACKGROUND_LOOKUP_WAIT, finished(done)).await;
            }
            source = "dht";
        } else {
            source = "budget";
        }

        let found = self.newest(key);
        let ms = started.elapsed().as_millis();
        let newer = found.as_ref().map(|p| p.timestamp()) != before;
        // Quiet in the steady state: a line when something changed, took long, or is missing.
        if newer || ms > 700 || found.is_none() {
            let age = found
                .as_ref()
                .map(|p| {
                    format!(
                        " age={}ms",
                        (pkarr::Timestamp::now()
                            .as_u64()
                            .saturating_sub(p.timestamp().as_u64()))
                            / 1000
                    )
                })
                .unwrap_or_default();
            diagnostics::log(&format!(
                "pkarr read {} {ms}ms {source}{} -> {}{age}",
                short(key),
                if background { " background" } else { "" },
                if found.is_some() {
                    if newer {
                        "newer"
                    } else {
                        "same"
                    }
                } else {
                    "none"
                }
            ));
        }
        found
    }

    /// The lookup running for `key`, started if none is.
    fn look_up(&self, key: &PublicKey) -> Option<watch::Receiver<bool>> {
        let client = self.inner.lookup.clone()?;
        let mut state = self.inner.state.lock().unwrap();
        if let Some(done) = state.lookups.get(key) {
            return Some(done.clone());
        }
        let (tx, rx) = watch::channel(false);
        state.lookups.insert(key.clone(), rx.clone());
        let (inner, key) = (self.inner.clone(), key.clone());
        tokio::spawn(async move {
            let found = client.resolve(&key, ResolvePolicy::NetworkOnly).await.ok();
            let mut state = inner.state.lock().unwrap();
            if let Some(packet) = found {
                state.keep(packet);
            }
            state.lookups.remove(&key);
            let _ = tx.send(true);
        });
        Some(rx)
    }

    /// The relay to ask now: not resting, within this client's budget (spent when `budgeted`), and of
    /// those the one that says it has the most requests left for this address; in turn when none says.
    fn pick_relay(&self, budgeted: bool) -> Option<usize> {
        let mut state = self.inner.state.lock().unwrap();
        let now = Instant::now();
        let count = state.relays.len();
        let turn = state.turn;
        state.turn = state.turn.wrapping_add(1);
        let mut best: Option<(usize, i64, usize)> = None;
        for offset in 0..count {
            let index = (turn + offset) % count;
            if !state.relays[index].available(now, self.inner.reads_per_minute) {
                continue;
            }
            // Unknown counts as plenty: a relay that never said is one to ask.
            let remaining = state.relays[index].remaining.unwrap_or(i64::MAX);
            if remaining < RESERVE {
                continue;
            }
            if best.is_none_or(|(_, most, _)| remaining > most) {
                best = Some((index, remaining, offset));
            }
        }
        let (index, _, _) = best?;
        if budgeted {
            state.relays[index].spend(now);
        }
        Some(index)
    }

    /// Another relay for a second opinion: available, and with `SECOND_OPINION_RESERVE` requests left there.
    fn pick_relay_other_than(&self, index: usize) -> Option<usize> {
        let mut state = self.inner.state.lock().unwrap();
        let now = Instant::now();
        let count = state.relays.len();
        let other = (0..count).filter(|&i| i != index).find(|&i| {
            state.relays[i].available(now, self.inner.reads_per_minute)
                && state.relays[i].remaining.unwrap_or(i64::MAX) >= SECOND_OPINION_RESERVE
        })?;
        state.relays[other].spend(now);
        Some(other)
    }

    /// One GET at a relay, as a poll makes it: `READ_TIMEOUT` at most, the relay's rate-limit headers noted.
    async fn relay_get(&self, index: usize, key: &PublicKey) -> RelayAnswer {
        self.relay_get_within(index, key, READ_TIMEOUT).await
    }

    async fn relay_get_within(
        &self,
        index: usize,
        key: &PublicKey,
        timeout: Duration,
    ) -> RelayAnswer {
        let response = match self
            .inner
            .http
            .get(self.key_url(index, key))
            .timeout(timeout)
            .send()
            .await
        {
            Ok(response) => response,
            Err(e) if e.is_timeout() => return RelayAnswer::Timeout,
            Err(e) if e.is_connect() => return RelayAnswer::Unreachable(e.to_string()),
            Err(e) => return RelayAnswer::Other(e.to_string()),
        };
        self.note_rate_limit(index, &response);
        match response.status().as_u16() {
            200 => {
                if response
                    .content_length()
                    .is_some_and(|len| len > MAX_BODY as u64)
                {
                    return RelayAnswer::Other("body too large".into());
                }
                match response.bytes().await {
                    Ok(bytes) if bytes.len() <= MAX_BODY => {
                        match SignedPacket::from_relay_payload(key, &bytes) {
                            Ok(packet) => RelayAnswer::Packet(packet),
                            Err(e) => RelayAnswer::Other(format!("invalid packet: {e}")),
                        }
                    }
                    Ok(_) => RelayAnswer::Other("body too large".into()),
                    Err(e) if e.is_timeout() => RelayAnswer::Timeout,
                    Err(e) => RelayAnswer::Other(e.to_string()),
                }
            }
            404 => RelayAnswer::Missing,
            429 => RelayAnswer::RateLimited,
            status => RelayAnswer::Other(format!("status {status}")),
        }
    }

    fn key_url(&self, index: usize, key: &PublicKey) -> Url {
        let mut url = self.inner.relays[index].clone();
        if let Ok(mut segments) = url.path_segments_mut() {
            segments.push(&key.to_z32());
        }
        url
    }

    /// What the relay says about its limit for this address, on every answer.
    fn note_rate_limit(&self, index: usize, response: &reqwest::Response) {
        let header = |name: &str| {
            response
                .headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse::<i64>().ok())
        };
        let (remaining, limit) = (header("x-ratelimit-remaining"), header("x-ratelimit-limit"));
        if remaining.is_none() && limit.is_none() {
            return;
        }
        let mut state = self.inner.state.lock().unwrap();
        let budget = &mut state.relays[index];
        if remaining.is_some() {
            budget.remaining = remaining;
        }
        if let Some(limit) = limit {
            budget.limit = Some(limit.max(0) as usize);
        }
    }

    /// One PUT at a relay, telling it which packet of ours it replaces (`If-Match`): a relay refuses
    /// (428) to replace a packet whose DHT put is still in flight unless told, and a link publishes in
    /// bursts (its presence, then its offer). 412 means it never got the one named: insist without.
    async fn relay_put(&self, index: usize, packet: &SignedPacket) -> Result<(), String> {
        let key = packet.public_key();
        let previous = {
            let mut state = self.inner.state.lock().unwrap();
            state.relays[index]
                .last_put
                .insert(key.clone(), packet.timestamp())
        };
        let url = self.key_url(index, &key);
        let body = packet.to_relay_payload();
        let send = |replaces: Option<pkarr::Timestamp>| {
            let mut request = self
                .inner
                .http
                .put(url.clone())
                .timeout(WRITE_TIMEOUT)
                .body(body.clone());
            if let Some(replaces) = replaces {
                request = request.header("if-match", replaces.as_u64().to_string());
            }
            request.send()
        };
        let mut response = send(previous).await.map_err(|e| brief(&e.to_string()))?;
        self.note_rate_limit(index, &response);
        if response.status().as_u16() == 412 && previous.is_some() {
            response = send(None).await.map_err(|e| brief(&e.to_string()))?;
            self.note_rate_limit(index, &response);
        }
        // 428: the relay holds a packet someone else put there moments ago (the inviter warming this
        // key) and its DHT put is still in flight. Learn which, and name it.
        if response.status().as_u16() == 428 && previous.is_none() {
            if let RelayAnswer::Packet(current) = self.relay_get(index, &key).await {
                if current.timestamp() < packet.timestamp() {
                    response = send(Some(current.timestamp()))
                        .await
                        .map_err(|e| brief(&e.to_string()))?;
                    self.note_rate_limit(index, &response);
                }
            }
        }
        // 409 with nothing of ours there before: the relay is still putting the packet the inviter warmed
        // this key with, and says so this way. It takes it a few seconds; try again, twice.
        let mut retries = 0;
        while response.status().as_u16() == 409 && previous.is_none() && retries < FIRST_PUT_RETRIES
        {
            retries += 1;
            tokio::time::sleep(FIRST_PUT_RETRY_AFTER).await;
            response = send(None).await.map_err(|e| brief(&e.to_string()))?;
            self.note_rate_limit(index, &response);
        }
        match response.status().as_u16() {
            200..=299 => Ok(()),
            429 => {
                self.inner.state.lock().unwrap().relays[index].rest();
                Err("rate limited".into())
            }
            409 => Err("relay has a more recent packet".into()),
            428 => Err("relay is still putting another packet".into()),
            status => Err(format!("status {status}")),
        }
    }

    fn relay_answered(&self, index: usize, answer: RelayAnswer) {
        let mut state = self.inner.state.lock().unwrap();
        match answer {
            RelayAnswer::Packet(packet) => {
                state.keep(packet);
            }
            // A missing key times out (the relay is asking its DHT); that is not a reason to rest.
            RelayAnswer::Missing | RelayAnswer::Timeout => {}
            RelayAnswer::RateLimited => state.relays[index].rest(),
            RelayAnswer::Unreachable(reason) => {
                state.relays[index].rest();
                diagnostics::log(&format!(
                    "pkarr relay {} unreachable: {}",
                    self.inner.relays[index].host_str().unwrap_or("?"),
                    brief(&reason)
                ));
            }
            RelayAnswer::Other(reason) => diagnostics::log(&format!(
                "pkarr relay {} answered oddly: {reason}",
                self.inner.relays[index].host_str().unwrap_or("?")
            )),
        }
    }

    fn newest(&self, key: &PublicKey) -> Option<SignedPacket> {
        let mut state = self.inner.state.lock().unwrap();
        let seen = state.newest.get_mut(key)?;
        seen.read_at = Instant::now();
        Some(seen.packet.clone())
    }
}

impl State {
    /// Remembers `packet` if it is the newest seen under its key; says whether it was.
    fn keep(&mut self, packet: SignedPacket) -> bool {
        let key = packet.public_key();
        if let Some(seen) = self.newest.get_mut(&key) {
            if packet.more_recent_than(&seen.packet) {
                seen.packet = packet;
                return true;
            }
            return false;
        }
        if self.newest.len() >= REMEMBERED_KEYS {
            let stalest = self
                .newest
                .iter()
                .min_by_key(|(_, seen)| seen.read_at)
                .map(|(key, _)| key.clone());
            if let Some(stalest) = stalest {
                self.newest.remove(&stalest);
            }
        }
        let read_at = Instant::now();
        self.newest.insert(key, Seen { packet, read_at });
        true
    }
}

impl RelayBudget {
    /// Not resting, and this client has reads left for it this minute: `reads_per_minute` until the
    /// relay said its own limit, half of that (within bounds) from then on. No cap stays no cap.
    fn available(&mut self, now: Instant, reads_per_minute: usize) -> bool {
        if self.resting_until.is_some_and(|until| until > now) {
            return false;
        }
        while self
            .spent
            .front()
            .is_some_and(|at| now.duration_since(*at) >= Duration::from_secs(60))
        {
            self.spent.pop_front();
        }
        let cap = match self.limit {
            Some(limit) if reads_per_minute != usize::MAX => {
                (limit / 2).clamp(READS_PER_MINUTE_LEAST, READS_PER_MINUTE_MOST)
            }
            _ => reads_per_minute,
        };
        self.spent.len() < cap
    }

    fn spend(&mut self, now: Instant) {
        self.spent.push_back(now);
    }

    fn rest(&mut self) {
        self.resting_until = Some(Instant::now() + REST);
    }
}

/// `GHOSTLY_PKARR_RELAYS`, read: `None` when unset or empty, an error for a URL that is not one.
fn private_relays(list: Option<&str>) -> Result<Option<Vec<Url>>, String> {
    let urls: Vec<&str> = list
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .collect();
    if urls.is_empty() {
        return Ok(None);
    }
    urls.iter()
        .map(|url| {
            url.parse::<Url>()
                .map_err(|e| format!("GHOSTLY_PKARR_RELAYS: {url}: {e}"))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

async fn finished(mut done: watch::Receiver<bool>) {
    // An error means the lookup task is gone, which is finished too.
    let _ = done.wait_for(|done| *done).await;
}

#[cfg(test)]
mod tests {
    // covers: chat.paired.pair, chat.dht.delivery
    use super::*;
    use crate::test_support::{closed_port, pkarr_client, pkarr_relay, Relay};
    use pkarr::Keypair;

    fn packet(keypair: &Keypair, value: &str) -> SignedPacket {
        SignedPacket::builder()
            .txt("_n".try_into().unwrap(), value.try_into().unwrap(), 300)
            .sign(keypair)
            .unwrap()
    }

    fn put(relay: &Relay, packet: &SignedPacket) {
        relay.packets.lock().unwrap().insert(
            packet.public_key().to_z32(),
            packet.to_relay_payload().to_vec(),
        );
    }

    fn slow(relay: &Relay, millis: u64) {
        *relay.delay.lock().unwrap() = Duration::from_millis(millis);
    }

    fn gets(relay: &Relay) -> usize {
        let requests = relay.requests.lock().unwrap();
        requests.iter().filter(|r| r.starts_with("GET")).count()
    }

    /// `fast` stands for a relay, `slow` for the DHT behind the lookup.
    fn desktop(fast: &Relay, slow: &Relay) -> Pkarr {
        Pkarr::new(Some(pkarr_client(slow)), &[fast.url.parse().unwrap()]).unwrap()
    }

    fn value(packet: &SignedPacket) -> String {
        let record = packet.all_resource_records().next().unwrap();
        match &record.rdata {
            simple_dns::rdata::RData::TXT(txt) => String::try_from(txt.clone()).unwrap(),
            _ => unreachable!(),
        }
    }

    #[tokio::test]
    async fn a_read_takes_the_relays_copy_without_waiting_for_the_dht() {
        let (fast, dht) = (pkarr_relay().await, pkarr_relay().await);
        let keypair = Keypair::random();
        let first = packet(&keypair, "1");
        put(&fast, &first);
        put(&dht, &first);
        slow(&dht, 2_000);

        let pkarr = desktop(&fast, &dht);
        let started = Instant::now();
        let got = pkarr.resolve(&keypair.public_key()).await.unwrap();
        assert_eq!(value(&got), "1");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(gets(&dht), 1, "the lookup runs on in the background");
    }

    #[tokio::test]
    async fn a_packet_only_the_dht_has_arrives_one_poll_later_and_stays() {
        let (fast, dht) = (pkarr_relay().await, pkarr_relay().await);
        let keypair = Keypair::random();
        let old = packet(&keypair, "old");
        let new = packet(&keypair, "new");
        put(&fast, &old);
        put(&dht, &new);
        slow(&dht, 300);

        let pkarr = desktop(&fast, &dht);
        let key = keypair.public_key();
        assert_eq!(value(&pkarr.resolve(&key).await.unwrap()), "old");
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_eq!(value(&pkarr.resolve(&key).await.unwrap()), "new");
        // The relay still serves the old one: the newest seen wins.
        assert_eq!(value(&pkarr.resolve(&key).await.unwrap()), "new");
    }

    #[tokio::test]
    async fn a_key_no_relay_knows_waits_for_the_dht() {
        let (fast, dht) = (pkarr_relay().await, pkarr_relay().await);
        let keypair = Keypair::random();
        put(&dht, &packet(&keypair, "dht"));
        slow(&dht, 300);

        let pkarr = desktop(&fast, &dht);
        // A read returns once the relay answered empty-handed and a moment passed; the lookup runs on,
        // and the next poll has what it found.
        let key = keypair.public_key();
        let mut got = pkarr.resolve(&key).await;
        for _ in 0..10 {
            if got.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
            got = pkarr.resolve(&key).await;
        }
        assert_eq!(value(&got.unwrap()), "dht");
        assert!(pkarr
            .resolve(&Keypair::random().public_key())
            .await
            .is_none());
    }

    #[tokio::test]
    async fn a_read_of_a_key_nobody_has_does_not_wait_for_the_dht_lookup() {
        let (fast, dht) = (pkarr_relay().await, pkarr_relay().await);
        slow(&dht, 2_000);
        let pkarr = desktop(&fast, &dht);
        let started = Instant::now();
        assert!(pkarr
            .resolve(&Keypair::random().public_key())
            .await
            .is_none());
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "{:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn a_background_read_asks_no_relay() {
        let (fast, dht) = (pkarr_relay().await, pkarr_relay().await);
        let keypair = Keypair::random();
        put(&dht, &packet(&keypair, "1"));
        let pkarr = desktop(&fast, &dht);
        assert_eq!(
            value(
                &pkarr
                    .resolve_with(&keypair.public_key(), true, false)
                    .await
                    .unwrap()
            ),
            "1"
        );
        assert_eq!((gets(&fast), gets(&dht)), (0, 1));
    }

    #[tokio::test]
    async fn polls_share_one_lookup_per_key() {
        let (fast, dht) = (pkarr_relay().await, pkarr_relay().await);
        let keypair = Keypair::random();
        put(&fast, &packet(&keypair, "1"));
        slow(&dht, 500);

        let pkarr = desktop(&fast, &dht);
        let key = keypair.public_key();
        for _ in 0..3 {
            pkarr.resolve(&key).await.unwrap();
        }
        assert_eq!((gets(&fast), gets(&dht)), (3, 1));
        tokio::time::sleep(Duration::from_millis(800)).await;
        pkarr.resolve(&key).await.unwrap();
        assert_eq!(gets(&dht), 2, "the next poll after it ends starts another");
    }

    #[tokio::test]
    async fn a_packet_signed_by_another_key_is_never_kept() {
        let (fast, dht) = (pkarr_relay().await, pkarr_relay().await);
        let (keypair, forger) = (Keypair::random(), Keypair::random());
        let forged = packet(&forger, "forged");
        for relay in [&fast, &dht] {
            relay.packets.lock().unwrap().insert(
                keypair.public_key().to_z32(),
                forged.to_relay_payload().to_vec(),
            );
        }
        let pkarr = desktop(&fast, &dht);
        assert!(pkarr.resolve(&keypair.public_key()).await.is_none());
    }

    #[tokio::test]
    async fn reads_stay_within_each_relays_budget_and_still_answer() {
        let (a, b) = (pkarr_relay().await, pkarr_relay().await);
        let keypair = Keypair::random();
        let first = packet(&keypair, "1");
        put(&a, &first);
        put(&b, &first);
        let pkarr = Pkarr::new(None, &[a.url.parse().unwrap(), b.url.parse().unwrap()]).unwrap();
        for _ in 0..(READS_PER_MINUTE * 2 + 10) {
            assert_eq!(
                value(&pkarr.resolve(&keypair.public_key()).await.unwrap()),
                "1"
            );
        }
        assert_eq!((gets(&a), gets(&b)), (READS_PER_MINUTE, READS_PER_MINUTE));
    }

    #[tokio::test]
    async fn relays_of_ones_own_are_read_every_time_and_published_to_alone() {
        let relay = pkarr_relay().await;
        let keypair = Keypair::random();
        let pkarr = Pkarr::private(&[relay.url.parse().unwrap()]).unwrap();
        pkarr.publish(&packet(&keypair, "1")).await.unwrap();
        for _ in 0..(READS_PER_MINUTE + 10) {
            assert_eq!(
                value(&pkarr.resolve(&keypair.public_key()).await.unwrap()),
                "1"
            );
        }
        // No budget: a private relay answers every poll, so a newer packet is seen at once.
        assert_eq!(gets(&relay), READS_PER_MINUTE + 10);
        tokio::time::sleep(Duration::from_millis(1_100)).await;
        pkarr.publish(&packet(&keypair, "2")).await.unwrap();
        assert_eq!(
            value(&pkarr.resolve(&keypair.public_key()).await.unwrap()),
            "2"
        );
    }

    #[test]
    fn ghostly_pkarr_relays_is_a_comma_separated_list_of_urls() {
        assert_eq!(private_relays(None).unwrap(), None);
        assert_eq!(private_relays(Some(" , ")).unwrap(), None);
        let relays = private_relays(Some("http://127.0.0.1:1, http://127.0.0.1:2/"))
            .unwrap()
            .unwrap();
        assert_eq!(
            relays.iter().map(Url::as_str).collect::<Vec<_>>(),
            ["http://127.0.0.1:1/", "http://127.0.0.1:2/"]
        );
        assert!(private_relays(Some("not a url"))
            .unwrap_err()
            .contains("GHOSTLY_PKARR_RELAYS"));
    }

    #[tokio::test]
    async fn an_unreachable_relay_rests_while_the_others_take_its_turns() {
        let relay = pkarr_relay().await;
        let keypair = Keypair::random();
        put(&relay, &packet(&keypair, "1"));
        let down = format!("http://127.0.0.1:{}", closed_port());
        let pkarr = Pkarr::new(None, &[down.parse().unwrap(), relay.url.parse().unwrap()]).unwrap();
        let key = keypair.public_key();
        assert!(
            pkarr.resolve(&key).await.is_none(),
            "the first turn is the dead relay's"
        );
        for _ in 0..3 {
            assert!(pkarr.resolve(&key).await.is_some());
        }
        assert_eq!(gets(&relay), 3);
    }

    #[tokio::test]
    async fn a_relay_still_putting_another_packet_is_told_which_one_this_replaces() {
        // The inviter warmed this key a moment ago; the relay is still putting that packet on the DHT.
        let relay = pkarr_relay().await;
        let keypair = Keypair::random();
        let warm = packet(&keypair, "warm");
        put(&relay, &warm);
        *relay.putting.lock().unwrap() = true;
        let pkarr = Pkarr::private(&[relay.url.parse().unwrap()]).unwrap();
        tokio::time::sleep(Duration::from_millis(1_100)).await;
        let mine = packet(&keypair, "mine");
        pkarr.publish(&mine).await.unwrap();
        assert_eq!(
            value(&pkarr.resolve(&keypair.public_key()).await.unwrap()),
            "mine"
        );
        let requests = relay.requests.lock().unwrap().clone();
        let key = keypair.public_key().to_z32();
        assert_eq!(
            requests
                .iter()
                .filter(|r| r.starts_with("PUT"))
                .collect::<Vec<_>>(),
            [
                &format!("PUT /{key}"),
                &format!("PUT /{key} if-match={}", warm.timestamp().as_u64())
            ],
            "refused once, then named the packet it replaces: {requests:?}"
        );
        // An older packet is not forced through: the relay holds a more recent one, and that is that.
        assert!(pkarr.publish(&warm).await.is_err());
    }

    #[tokio::test]
    async fn reads_go_to_the_relay_with_the_most_requests_left_for_this_address() {
        let (scarce, plenty) = (pkarr_relay().await, pkarr_relay().await);
        scarce.headers.lock().unwrap().extend([
            ("x-ratelimit-limit".into(), "50".into()),
            ("x-ratelimit-remaining".into(), "3".into()),
        ]);
        plenty.headers.lock().unwrap().extend([
            ("x-ratelimit-limit".into(), "1000".into()),
            ("x-ratelimit-remaining".into(), "900".into()),
        ]);
        let keypair = Keypair::random();
        let first = packet(&keypair, "1");
        put(&scarce, &first);
        put(&plenty, &first);
        let pkarr = Pkarr::new(
            None,
            &[scarce.url.parse().unwrap(), plenty.url.parse().unwrap()],
        )
        .unwrap();
        for _ in 0..12 {
            pkarr.resolve(&keypair.public_key()).await.unwrap();
        }
        // Until they said, each was asked in turn; once the scarce one said it has 3 left, every read
        // went to the other.
        assert!(gets(&scarce) <= 2, "{}", gets(&scarce));
        assert_eq!(gets(&scarce) + gets(&plenty), 12);
    }

    #[tokio::test]
    async fn a_relays_own_limit_caps_this_clients_reads_at_half_of_it() {
        let relay = pkarr_relay().await;
        relay.headers.lock().unwrap().extend([
            ("x-ratelimit-limit".into(), "50".into()),
            ("x-ratelimit-remaining".into(), "45".into()),
        ]);
        let keypair = Keypair::random();
        put(&relay, &packet(&keypair, "1"));
        let pkarr = Pkarr::new(None, &[relay.url.parse().unwrap()]).unwrap();
        for _ in 0..40 {
            assert_eq!(
                value(&pkarr.resolve(&keypair.public_key()).await.unwrap()),
                "1"
            );
        }
        assert_eq!(
            gets(&relay),
            25,
            "half of 50, the rest answered from the newest seen"
        );
    }

    #[tokio::test]
    async fn a_packet_is_published_to_the_relays_and_the_dht_and_one_is_enough() {
        let (fast, dht) = (pkarr_relay().await, pkarr_relay().await);
        let keypair = Keypair::random();
        let key = keypair.public_key().to_z32();
        desktop(&fast, &dht)
            .publish(&packet(&keypair, "1"))
            .await
            .unwrap();
        // A publish returns on the first taker; the other writes finish on their own.
        for _ in 0..20 {
            if dht.packets.lock().unwrap().contains_key(&key) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(fast.packets.lock().unwrap().contains_key(&key));
        assert!(dht.packets.lock().unwrap().contains_key(&key));

        let down: Url = format!("http://127.0.0.1:{}", closed_port())
            .parse()
            .unwrap();
        let half = Pkarr::new(Some(pkarr_client(&dht)), std::slice::from_ref(&down)).unwrap();
        half.publish(&packet(&keypair, "2")).await.unwrap();

        let none = Pkarr::new(None, &[down]).unwrap();
        let error = none.publish(&packet(&keypair, "3")).await.unwrap_err();
        assert!(error.starts_with("Publish error"), "{error}");
    }
}

/// Timings against the real DHT and relays, printed rather than asserted:
/// `cargo test --manifest-path src-tauri/Cargo.toml live_ -- --ignored --nocapture --test-threads 1`.
/// Mind the relays' limit of about 120 requests a minute per IP between runs.
#[cfg(test)]
mod live {
    use super::*;
    use pkarr::Keypair;

    fn packet(keypair: &Keypair, value: &str) -> SignedPacket {
        SignedPacket::builder()
            .txt("_n".try_into().unwrap(), value.try_into().unwrap(), 300)
            .sign(keypair)
            .unwrap()
    }

    /// What Desktop read with before: DHT and relays joined, NetworkOnly.
    fn combined() -> Client {
        let mut builder = Client::builder();
        builder.cache_size(50);
        builder.build().unwrap()
    }

    fn line(name: &str, times: &[f64]) {
        let mut sorted = times.to_vec();
        sorted.sort_by(f64::total_cmp);
        let shown: Vec<_> = times.iter().map(|t| format!("{t:.2}")).collect();
        println!(
            "{name}: median {:.2} s, min {:.2}, max {:.2} [{}]",
            sorted[sorted.len() / 2],
            sorted[0],
            sorted[sorted.len() - 1],
            shown.join(", ")
        );
    }

    /// Polls every second from `start` until `read` returns `want`.
    async fn visible_after<F, Fut>(start: Instant, want: u64, read: F) -> f64
    where
        F: Fn() -> Fut,
        Fut: std::future::Future<Output = Option<u64>>,
    {
        loop {
            let poll = Instant::now();
            if read().await == Some(want) || start.elapsed() > Duration::from_secs(30) {
                return start.elapsed().as_secs_f64();
            }
            tokio::time::sleep(Duration::from_secs(1).saturating_sub(poll.elapsed())).await;
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "reaches the real DHT and relays"]
    async fn live_read_latency() {
        let (old, new) = (combined(), Pkarr::desktop().unwrap());
        tokio::time::sleep(Duration::from_secs(3)).await; // the DHT nodes bootstrap
        let keypair = Keypair::random();
        new.publish(&packet(&keypair, "1")).await.unwrap();
        tokio::time::sleep(Duration::from_secs(8)).await;
        let key = keypair.public_key();

        let (mut before, mut after) = (vec![], vec![]);
        for _ in 0..8 {
            let started = Instant::now();
            assert!(old.resolve(&key, ResolvePolicy::NetworkOnly).await.is_ok());
            before.push(started.elapsed().as_secs_f64());
            let started = Instant::now();
            assert!(new.resolve(&key).await.is_some());
            after.push(started.elapsed().as_secs_f64());
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        line("read, before (combined NetworkOnly)", &before);
        line("read, after (relay first, DHT behind)", &after);

        let (mut before, mut after) = (vec![], vec![]);
        for _ in 0..3 {
            let key = Keypair::random().public_key();
            let started = Instant::now();
            assert!(old.resolve(&key, ResolvePolicy::NetworkOnly).await.is_err());
            before.push(started.elapsed().as_secs_f64());
            let started = Instant::now();
            assert!(new.resolve(&key).await.is_none());
            after.push(started.elapsed().as_secs_f64());
        }
        line("missing key, before", &before);
        line("missing key, after", &after);
    }

    /// The newest timestamp a reader sees: before (`old`) or after.
    async fn read(old: &Client, new: &Pkarr, after: bool, key: &PublicKey) -> Option<u64> {
        let packet = if after {
            new.resolve(key).await
        } else {
            old.resolve(key, ResolvePolicy::NetworkOnly).await.ok()
        };
        packet.map(|p| p.timestamp().as_u64())
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "reaches the real DHT and relays"]
    async fn live_newer_packet_visible_after() {
        let (old, new) = (combined(), Pkarr::desktop().unwrap());
        // A peer that reaches only the DHT: the relays never hear of what it publishes.
        let mut dht = Client::builder();
        dht.no_relays();
        let dht = dht.build().unwrap();
        tokio::time::sleep(Duration::from_secs(3)).await;
        let mut seen: [[Vec<f64>; 2]; 2] = Default::default();
        for round in 0..8 {
            let after = round % 2 == 1;
            // Another peer, publishing the way Desktop does.
            let publisher = Pkarr::desktop().unwrap();
            let keypair = Keypair::random();
            let key = keypair.public_key();
            publisher.publish(&packet(&keypair, "1")).await.unwrap();
            tokio::time::sleep(Duration::from_secs(4)).await;
            read(&old, &new, after, &key).await; // the reader already knows the key

            let newer = packet(&keypair, "2");
            let want = newer.timestamp().as_u64();
            let started = Instant::now();
            let publishing = tokio::spawn(async move { publisher.publish(&newer).await });
            let at = visible_after(started, want, || read(&old, &new, after, &key)).await;
            seen[0][after as usize].push(at);
            publishing.await.unwrap().unwrap();

            // Timed from the moment the DHT put returns: the packet is there to be found.
            let newest = packet(&keypair, "3");
            let want = newest.timestamp().as_u64();
            dht.publish(&newest).await.unwrap();
            let started = Instant::now();
            let at = visible_after(started, want, || read(&old, &new, after, &key)).await;
            seen[1][after as usize].push(at);
        }
        line("newer packet seen, before", &seen[0][0]);
        line("newer packet seen, after", &seen[0][1]);
        line("DHT-only packet seen once on the DHT, before", &seen[1][0]);
        line("DHT-only packet seen once on the DHT, after", &seen[1][1]);
    }
}
