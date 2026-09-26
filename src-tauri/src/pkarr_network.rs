//! Pkarr as Ghostly Desktop reaches it: the Mainline DHT, directly, and the public relays.
//!
//! Reads go to the DHT by default. A lookup gives its first answer in about 0.8 s
//! and finishes (every close node asked, the newest packet among them) in about
//! 3.4 s; a read that knows nothing of the key yet waits for the first answer, a
//! read that knows something returns it at once, and the lookup runs on in the
//! background. Every packet found is kept as that key's newest (signatures
//! verified by pkarr, the newest timestamp wins), and a read returns the newest
//! seen: one that arrived during a lookup is at most one poll late.
//!
//! Writes go to the DHT and to the relays. The browser clients can only read
//! relays, and a relay keeps serving the copy it has for minutes: without our
//! PUT it would hand a browser contact an old packet. Reading the relays too
//! ("Also use Pkarr relays" in Settings, `read_relays`) is the accelerator: a
//! relay hands over the copy it holds in about 0.3 s, so a read asks one relay
//! and returns, while a DHT lookup for the same key runs on behind it.
//!
//! Publishing returns as soon as a write succeeded. With relay reads on it also
//! reads the packet back from a relay: a relay keeps a packet the moment the PUT
//! arrives and serves it from then on, but answers only after its own DHT put,
//! seconds later, and a link publishes several times while pairing (its
//! presence, its offer, its answer), one after the other.
//!
//! Every relay has a circuit breaker: three failures in a row (no answer, a
//! server error, its rate limit) and it is left alone for a minute, twice as
//! long each time it trips again, five minutes at most; then one request
//! probes it. Reads with relay reads on go to the DHT while every relay is left
//! alone.

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddrV4;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use pkarr::dht::{DhtClient, DhtConfig};
use pkarr::{Client, PublicKey, ResolvePolicy, SignedPacket};
use serde::Serialize;
use tokio::sync::watch;
use url::Url;

use crate::diagnostics;

/// The relays written to before Settings named any: the browser clients' defaults
/// (`DEFAULT_RELAYS` in packages/core/src/relay.ts). The app hands over the list
/// in Settings as it starts, so a relay is added there, not here.
pub const DEFAULT_RELAYS: [&str; 3] = [
    "https://pkarr.pubky.org",
    "https://pkarr.pubky.app",
    "https://relay.pkarr.org",
];

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
/// A DHT read of a key nothing is known of yet (or of one a signal is due on) waits this long for the
/// lookup's first answer: 0.5 to 1 s on the real DHT. A key nobody published takes the whole lookup to
/// say so (3.3 s); the read returns before, and the next poll has the answer.
const DHT_ANSWER_WAIT: Duration = Duration::from_millis(1_500);
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
const READS_PER_MINUTE_LEAST: usize = 5;
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
/// Failures in a row that trip a relay's breaker (as the browser clients', packages/core/src/relayBreaker.ts).
const BREAKER_THRESHOLD: u32 = 3;
/// How long a tripped relay is left alone the first time; doubled on each trip in a row, up to the most.
const BREAKER_BASE: Duration = Duration::from_secs(60);
const BREAKER_MAX: Duration = Duration::from_secs(300);

/// The DHT as this client reaches it: the Mainline DHT itself, or, in tests, a stand-in behind a Pkarr client.
#[derive(Clone)]
pub enum Dht {
    Mainline(DhtClient),
    #[cfg_attr(not(test), allow(dead_code))]
    StandIn(Client),
}

impl Dht {
    /// A node of the Mainline DHT, joining through `bootstrap` (the public bootstrap nodes when `None`).
    pub fn mainline(bootstrap: Option<Vec<SocketAddrV4>>) -> Result<Self, String> {
        let mut config = DhtConfig::default();
        config.bootstrap = bootstrap;
        DhtClient::build(config)
            .map(Dht::Mainline)
            .map_err(|e| format!("DHT node: {e}"))
    }

    async fn publish(&self, packet: &SignedPacket) -> Result<(), String> {
        match self {
            Dht::Mainline(dht) => dht
                .publish(packet)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string()),
            Dht::StandIn(client) => client
                .publish(packet)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string()),
        }
    }

    /// Looks `key` up: `first` is handed the first packet found, the return is the most recent one.
    async fn resolve(
        &self,
        key: &PublicKey,
        first: impl FnOnce(&SignedPacket),
    ) -> Option<SignedPacket> {
        match self {
            Dht::Mainline(dht) => {
                let response = dht.resolve(key, None).await;
                if let Some(packet) = response.first() {
                    first(packet);
                }
                response.complete().await.most_recent.ok()
            }
            Dht::StandIn(client) => {
                let found = client.resolve(key, ResolvePolicy::NetworkOnly).await.ok();
                if let Some(packet) = &found {
                    first(packet);
                }
                found
            }
        }
    }
}

pub struct Pkarr {
    inner: Arc<Inner>,
}

struct Inner {
    /// Looks keys up, and is published to. The DHT in the app.
    lookup: Option<Dht>,
    http: reqwest::Client,
    /// READS_PER_MINUTE for the public relays; none for relays of one's own.
    reads_per_minute: usize,
    /// The relays were named by `GHOSTLY_PKARR_RELAYS`: Settings do not replace them.
    fixed_relays: bool,
    state: Mutex<State>,
}

struct State {
    newest: HashMap<PublicKey, Seen>,
    /// Lookups in flight, one per key: a poll never starts a second.
    lookups: HashMap<PublicKey, watch::Receiver<u8>>,
    /// The relays, read and written with plain HTTP (`READ_TIMEOUT` / `WRITE_TIMEOUT`, `If-Match` on
    /// writes, the relay's rate-limit headers read on every answer).
    relays: Vec<Relay>,
    /// Reads may go to the relays ("Also use Pkarr relays"); always, where there is no DHT.
    read_relays: bool,
    turn: usize,
    /// Where the last read went.
    path: Option<Path>,
}

/// A lookup's progress, as its watch channel carries it.
const LOOKING: u8 = 0;
const ANSWERED: u8 = 1;
const DONE: u8 = 2;

struct Seen {
    packet: SignedPacket,
    read_at: Instant,
}

struct Relay {
    url: Url,
    budget: RelayBudget,
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
    breaker: Breaker,
}

/// Why a request to a relay failed: its rate limit, or anything else.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Failure {
    Throttled,
    Error,
}

#[derive(Default)]
struct Breaker {
    failures: u32,
    /// Trips in a row, without an answer in between: the next wait doubles with each.
    trips: u32,
    open_until: Option<Instant>,
    /// The one request allowed once the wait is over is out.
    probing: bool,
    kind: Option<Failure>,
    reason: String,
}

/// Where a read went, as the connection panel shows it: `{"via":"dht"}` or `{"via":"relay","relay":…}`.
#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(tag = "via", rename_all = "lowercase")]
pub enum Path {
    Dht,
    Relay { relay: String },
}

/// A relay's health, as packages/core's `RelayHealth`: `ok`, `throttled` or `failing`, until when (ms since the epoch).
#[derive(Serialize, PartialEq, Debug)]
pub struct RelayHealth {
    relay: String,
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    until: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

/// How reads go and how each relay is doing, as packages/core's `DiscoveryStatus`.
#[derive(Serialize, PartialEq, Debug)]
pub struct DiscoveryStatus {
    path: Option<Path>,
    relays: Vec<RelayHealth>,
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

fn host(url: &Url) -> String {
    url.host_str().unwrap_or("relay").to_string()
}

/// A relay's URL as Settings and the browser clients write it: no trailing slash.
fn plain(url: &Url) -> String {
    url.as_str().trim_end_matches('/').to_string()
}

impl Pkarr {
    /// The app's: the Mainline DHT, read directly, and the default relays, written to. Two variables
    /// change that, for a private network and the end-to-end tests: `GHOSTLY_PKARR_RELAYS` (comma-separated
    /// URLs) names the relays, and alone means those relays and nothing else, which is how the scenario matrix
    /// pairs Desktop with its other peers offline; `GHOSTLY_PKARR_DHT_BOOTSTRAP` (comma-separated `ip:port`)
    /// joins a DHT of one's own through those nodes instead of the public one.
    pub fn desktop() -> Result<Self, String> {
        let relays = private_relays(std::env::var("GHOSTLY_PKARR_RELAYS").ok().as_deref())?;
        let bootstrap =
            dht_bootstrap(std::env::var("GHOSTLY_PKARR_DHT_BOOTSTRAP").ok().as_deref())?;
        match (relays, bootstrap) {
            (Some(relays), None) => Self::private(&relays),
            (relays, bootstrap) => {
                let fixed = relays.is_some();
                let relays = relays.unwrap_or_else(|| {
                    DEFAULT_RELAYS
                        .map(|url| url.parse().expect("relay URLs"))
                        .to_vec()
                });
                Self::build(
                    Some(Dht::mainline(bootstrap)?),
                    &relays,
                    READS_PER_MINUTE,
                    false,
                    fixed,
                )
            }
        }
    }

    /// Relays of one's own and nothing else: no DHT, and no read budget, since
    /// the budget is there for the public relays' limits.
    pub fn private(relays: &[Url]) -> Result<Self, String> {
        Self::build(None, relays, usize::MAX, true, true)
    }

    /// The DHT read directly, `relays` written to; relay reads wait for `configure`.
    #[cfg(test)]
    pub fn direct(dht: Dht, relays: &[Url]) -> Result<Self, String> {
        Self::build(Some(dht), relays, READS_PER_MINUTE, false, false)
    }

    /// Relays read first, with `lookup` (a stand-in for the slow, complete source) behind them: what
    /// "Also use Pkarr relays" turns on.
    #[cfg(test)]
    pub fn new(lookup: Option<Client>, relays: &[Url]) -> Result<Self, String> {
        Self::build(
            lookup.map(Dht::StandIn),
            relays,
            READS_PER_MINUTE,
            true,
            false,
        )
    }

    fn build(
        lookup: Option<Dht>,
        relays: &[Url],
        reads_per_minute: usize,
        read_relays: bool,
        fixed_relays: bool,
    ) -> Result<Self, String> {
        // One HTTP client for every relay: connections are kept and reused.
        let http = reqwest::Client::builder()
            .build()
            .map_err(|e| format!("HTTP client: {e}"))?;
        let state = State {
            newest: HashMap::new(),
            lookups: HashMap::new(),
            relays: relays
                .iter()
                .map(|url| Relay {
                    url: url.clone(),
                    budget: RelayBudget::default(),
                })
                .collect(),
            read_relays: read_relays || lookup.is_none(),
            turn: 0,
            path: None,
        };
        Ok(Self {
            inner: Arc::new(Inner {
                lookup,
                http,
                reads_per_minute,
                fixed_relays,
                state: Mutex::new(state),
            }),
        })
    }

    /// Settings, Network: the relays written to, and whether reads may use them. Relays named by
    /// `GHOSTLY_PKARR_RELAYS` stay; without a DHT, reads always use the relays.
    pub fn configure(&self, relays: Vec<Url>, read_relays: bool) {
        let mut state = self.inner.state.lock().unwrap();
        state.read_relays = read_relays || self.inner.lookup.is_none();
        if self.inner.fixed_relays {
            return;
        }
        let mut kept: Vec<Relay> = std::mem::take(&mut state.relays);
        state.relays = relays
            .into_iter()
            .map(|url| match kept.iter().position(|relay| relay.url == url) {
                Some(index) => kept.swap_remove(index),
                None => Relay {
                    url,
                    budget: RelayBudget::default(),
                },
            })
            .collect();
    }

    /// Where reads go and how each relay is doing.
    pub fn status(&self) -> DiscoveryStatus {
        let state = self.inner.state.lock().unwrap();
        let (now, wall) = (Instant::now(), SystemTime::now());
        let at = |until: Instant| {
            (wall + until.saturating_duration_since(now))
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .ok()
        };
        DiscoveryStatus {
            path: state.path.clone(),
            relays: state
                .relays
                .iter()
                .map(|relay| {
                    let breaker = &relay.budget.breaker;
                    let (state, until, reason) = if breaker.blocked(now) {
                        let kind = if breaker.kind == Some(Failure::Throttled) {
                            "throttled"
                        } else {
                            "failing"
                        };
                        (
                            kind,
                            breaker.open_until.and_then(|until| at(until.max(now))),
                            Some(breaker.reason.clone()),
                        )
                    } else if let Some(until) =
                        relay.budget.resting_until.filter(|until| *until > now)
                    {
                        ("throttled", at(until), Some("rate limited (429)".into()))
                    } else {
                        ("ok", None, None)
                    };
                    RelayHealth {
                        relay: plain(&relay.url),
                        state,
                        until,
                        reason,
                    }
                })
                .collect(),
        }
    }

    /// Publishes to the DHT and every relay not left alone. Returns once the packet is out there to be read:
    /// a write succeeded, or (with relay reads on) a relay serves it back. The writes run on and log how
    /// they ended; an error means every one of them failed.
    pub async fn publish(&self, packet: &SignedPacket) -> Result<(), String> {
        let started = Instant::now();
        let key = packet.public_key();
        let inner = self.inner.clone();
        let (relays, read_relays) = {
            let state = inner.state.lock().unwrap();
            (
                state
                    .relays
                    .iter()
                    .map(|relay| relay.url.clone())
                    .collect::<Vec<_>>(),
                state.read_relays,
            )
        };
        // `outcome`: `None` while writes run, then whether any succeeded; `first_ok`: the first success.
        let (outcome_tx, mut outcome) = watch::channel::<Option<Result<(), String>>>(None);
        let (first_ok_tx, mut first_ok) = watch::channel(false);
        let writes: Vec<(String, Write)> = relays
            .into_iter()
            .map(|url| {
                let (this, packet) = (
                    Self {
                        inner: inner.clone(),
                    },
                    packet.clone(),
                );
                (
                    host(&url),
                    Box::pin(async move { this.relay_put(&url, &packet).await }) as _,
                )
            })
            .chain(inner.lookup.clone().map(|dht| {
                let packet = packet.clone();
                (
                    "dht".to_string(),
                    Box::pin(async move { dht.publish(&packet).await }) as _,
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
                } else if errors.is_empty() {
                    Err("Publish error: nowhere to publish".into())
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
        // Reading the packet back is a relay read: only where relay reads are on.
        let read_backs = if read_relays { READ_BACKS } else { 0 };
        let mut wait = READ_BACK_AFTER;
        for _ in 0..read_backs {
            tokio::select! {
                result = &mut settled => return self.published(&key, started, "settled", result),
                _ = async { let _ = first_ok.wait_for(|ok| *ok).await; } => return self.published(&key, started, "written", Ok(())),
                _ = tokio::time::sleep(wait) => {}
            }
            wait = READ_BACK_EVERY;
            // A read-back is not a poll: it spends none of the read budget (the relay counts it all the same).
            let Some(url) = self.pick_relay(false) else {
                continue;
            };
            let read = self.relay_get_within(&url, &key, READ_BACK_TIMEOUT);
            tokio::pin!(read);
            tokio::select! {
                result = &mut settled => return self.published(&key, started, "settled", result),
                _ = async { let _ = first_ok.wait_for(|ok| *ok).await; } => return self.published(&key, started, "written", Ok(())),
                answer = &mut read => {
                    let visible = matches!(&answer, RelayAnswer::Packet(seen) if seen.timestamp() >= wanted);
                    self.relay_answered(&url, answer);
                    if visible { return self.published(&key, started, "visible", Ok(())); }
                }
            }
        }
        tokio::select! {
            result = &mut settled => self.published(&key, started, if read_backs > 0 { "settled late" } else { "settled" }, result),
            _ = async { let _ = first_ok.wait_for(|ok| *ok).await; } => self.published(&key, started, "written", Ok(())),
        }
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
    /// `urgent`: a signal is due any moment. On the DHT, the read waits for the lookup's first answer even
    /// when a packet is known; with relay reads on, when the relay asked had nothing newer, a second relay
    /// with plenty of requests left is asked too (relays do not all serve a fresh packet at once).
    ///
    /// With relay reads on, a foreground read asks one relay and returns what is known the moment the
    /// relay answered (or `READ_TIMEOUT` passed): a key nobody has yet costs one read, not the DHT
    /// lookup's seconds too.
    pub async fn resolve_with(
        &self,
        key: &PublicKey,
        background: bool,
        urgent: bool,
    ) -> Option<SignedPacket> {
        let started = Instant::now();
        let before = self.newest(key).map(|p| p.timestamp());
        let lookup = self.look_up(key);
        let read_relays = self.inner.state.lock().unwrap().read_relays;
        let source;

        if !read_relays {
            // The DHT, directly (there is one: without it, relay reads are always on).
            if let Some(progress) = lookup {
                if background && self.newest(key).is_none() {
                    let _ = tokio::time::timeout(BACKGROUND_LOOKUP_WAIT, finished(progress)).await;
                } else if !background && (urgent || self.newest(key).is_none()) {
                    let _ = tokio::time::timeout(DHT_ANSWER_WAIT, answered(progress)).await;
                }
            }
            self.went(Path::Dht);
            source = "dht";
        } else if background {
            if self.newest(key).is_none() {
                if let Some(done) = lookup {
                    let _ = tokio::time::timeout(BACKGROUND_LOOKUP_WAIT, finished(done)).await;
                }
            }
            source = "dht";
        } else if let Some(url) = self.pick_relay(true) {
            let read = self.relay_get(&url, key);
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
                    if matches!(answer, RelayAnswer::Packet(_) | RelayAnswer::Missing) {
                        self.went(Path::Relay { relay: plain(&url) });
                    }
                    self.relay_answered(&url, answer);
                    source
                }
                // The lookup was quicker. Only an empty handed one waits for the relay.
                None if self.newest(key).is_none() => {
                    let answer = read.await;
                    self.relay_answered(&url, answer);
                    "relay-late"
                }
                None => {
                    self.went(Path::Dht);
                    "dht"
                }
            };
            // Nothing newer from that relay, and a signal is due: another relay may have it already.
            if urgent && self.newest(key).map(|p| p.timestamp()) == before {
                if let Some(other) = self.pick_relay_other_than(&url) {
                    let answer = self.relay_get(&other, key).await;
                    self.relay_answered(&other, answer);
                }
            }
            if self.newest(key).is_none() {
                if let Some(done) = lookup {
                    let _ = tokio::time::timeout(LOOKUP_GRACE, finished(done)).await;
                }
            }
        } else if self.newest(key).is_none() {
            // No relay to ask (budget spent, or every one left alone): the lookup is all there is.
            if let Some(done) = lookup {
                let _ = tokio::time::timeout(BACKGROUND_LOOKUP_WAIT, finished(done)).await;
                self.went(Path::Dht);
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

    fn went(&self, path: Path) {
        self.inner.state.lock().unwrap().path = Some(path);
    }

    /// The lookup running for `key`, started if none is.
    fn look_up(&self, key: &PublicKey) -> Option<watch::Receiver<u8>> {
        let dht = self.inner.lookup.clone()?;
        let mut state = self.inner.state.lock().unwrap();
        if let Some(progress) = state.lookups.get(key) {
            return Some(progress.clone());
        }
        let (tx, rx) = watch::channel(LOOKING);
        state.lookups.insert(key.clone(), rx.clone());
        let (inner, key) = (self.inner.clone(), key.clone());
        tokio::spawn(async move {
            let found = dht
                .resolve(&key, |first| {
                    inner.state.lock().unwrap().keep(first.clone());
                    let _ = tx.send(ANSWERED);
                })
                .await;
            let mut state = inner.state.lock().unwrap();
            if let Some(packet) = found {
                state.keep(packet);
            }
            state.lookups.remove(&key);
            let _ = tx.send(DONE);
        });
        Some(rx)
    }

    /// The relay to ask now: not resting nor left alone, within this client's budget (spent when
    /// `budgeted`), and of those the one that says it has the most requests left for this address; in
    /// turn when none says.
    fn pick_relay(&self, budgeted: bool) -> Option<Url> {
        let mut state = self.inner.state.lock().unwrap();
        let now = Instant::now();
        let count = state.relays.len();
        let turn = state.turn;
        state.turn = state.turn.wrapping_add(1);
        let mut best: Option<(usize, i64)> = None;
        for offset in 0..count {
            let index = (turn + offset) % count;
            if !state.relays[index]
                .budget
                .available(now, self.inner.reads_per_minute)
            {
                continue;
            }
            // Unknown counts as plenty: a relay that never said is one to ask.
            let remaining = state.relays[index].budget.remaining.unwrap_or(i64::MAX);
            if remaining < RESERVE {
                continue;
            }
            if best.is_none_or(|(_, most)| remaining > most) {
                best = Some((index, remaining));
            }
        }
        let (index, _) = best?;
        let budget = &mut state.relays[index].budget;
        budget.breaker.begin(now);
        if budgeted {
            budget.spend(now);
        }
        Some(state.relays[index].url.clone())
    }

    /// Another relay for a second opinion: available, and with `SECOND_OPINION_RESERVE` requests left there.
    fn pick_relay_other_than(&self, url: &Url) -> Option<Url> {
        let mut state = self.inner.state.lock().unwrap();
        let now = Instant::now();
        let reads_per_minute = self.inner.reads_per_minute;
        let other = (0..state.relays.len()).find(|&i| {
            state.relays[i].url != *url
                && state.relays[i].budget.available(now, reads_per_minute)
                && state.relays[i].budget.remaining.unwrap_or(i64::MAX) >= SECOND_OPINION_RESERVE
        })?;
        let budget = &mut state.relays[other].budget;
        budget.breaker.begin(now);
        budget.spend(now);
        Some(state.relays[other].url.clone())
    }

    /// Runs `f` on the relay's budget, if the relay is still in the list (Settings may have changed it).
    fn with_budget<T>(&self, url: &Url, f: impl FnOnce(&mut RelayBudget) -> T) -> Option<T> {
        let mut state = self.inner.state.lock().unwrap();
        state
            .relays
            .iter_mut()
            .find(|relay| relay.url == *url)
            .map(|relay| f(&mut relay.budget))
    }

    /// One GET at a relay, as a poll makes it: `READ_TIMEOUT` at most, the relay's rate-limit headers noted.
    async fn relay_get(&self, url: &Url, key: &PublicKey) -> RelayAnswer {
        self.relay_get_within(url, key, READ_TIMEOUT).await
    }

    async fn relay_get_within(&self, url: &Url, key: &PublicKey, timeout: Duration) -> RelayAnswer {
        let response = match self
            .inner
            .http
            .get(key_url(url, key))
            .timeout(timeout)
            .send()
            .await
        {
            Ok(response) => response,
            Err(e) if e.is_timeout() => return RelayAnswer::Timeout,
            Err(e) if e.is_connect() => return RelayAnswer::Unreachable(e.to_string()),
            Err(e) => return RelayAnswer::Other(e.to_string()),
        };
        self.note_rate_limit(url, &response);
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
            status => RelayAnswer::Other(format!("HTTP {status}")),
        }
    }

    /// What the relay says about its limit for this address, on every answer.
    fn note_rate_limit(&self, url: &Url, response: &reqwest::Response) {
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
        self.with_budget(url, |budget| {
            if remaining.is_some() {
                budget.remaining = remaining;
            }
            if let Some(limit) = limit {
                budget.limit = Some(limit.max(0) as usize);
            }
        });
    }

    /// The relay answered (`None`) or failed, for its breaker; a trip or a recovery is logged, never a key.
    fn breaker(&self, url: &Url, failure: Option<(Failure, &str)>) {
        let change = self.with_budget(url, |budget| match failure {
            None => budget
                .breaker
                .succeeded()
                .then(|| "answered again".to_string()),
            Some((kind, reason)) => budget
                .breaker
                .failed(Instant::now(), kind, reason)
                .map(|wait| format!("tripped ({reason}); left alone for {} s", wait.as_secs())),
        });
        if let Some(Some(line)) = change {
            diagnostics::log(&format!("pkarr relay {} {line}", host(url)));
        }
    }

    /// One PUT at a relay, telling it which packet of ours it replaces (`If-Match`): a relay refuses
    /// (428) to replace a packet whose DHT put is still in flight unless told, and a link publishes in
    /// bursts (its presence, then its offer). 412 means it never got the one named: insist without.
    async fn relay_put(&self, url: &Url, packet: &SignedPacket) -> Result<(), String> {
        let key = packet.public_key();
        let now = Instant::now();
        let Some(previous) = self.with_budget(url, |budget| {
            if budget.breaker.blocked(now) {
                return Err("left alone after failing".to_string());
            }
            budget.breaker.begin(now);
            Ok(budget.last_put.insert(key.clone(), packet.timestamp()))
        }) else {
            return Err("no longer in Settings".into());
        };
        let previous = previous?;
        let target = key_url(url, &key);
        let body = packet.to_relay_payload();
        let send = |replaces: Option<pkarr::Timestamp>| {
            let mut request = self
                .inner
                .http
                .put(target.clone())
                .timeout(WRITE_TIMEOUT)
                .body(body.clone());
            if let Some(replaces) = replaces {
                request = request.header("if-match", replaces.as_u64().to_string());
            }
            request.send()
        };
        let failed = |e: reqwest::Error| {
            let reason = if e.is_timeout() {
                "no answer in time"
            } else {
                "no answer"
            };
            self.breaker(url, Some((Failure::Error, reason)));
            brief(&e.to_string())
        };
        let mut response = send(previous).await.map_err(&failed)?;
        self.note_rate_limit(url, &response);
        if response.status().as_u16() == 412 && previous.is_some() {
            response = send(None).await.map_err(&failed)?;
            self.note_rate_limit(url, &response);
        }
        // 428: the relay holds a packet someone else put there moments ago (the inviter warming this
        // key) and its DHT put is still in flight. Learn which, and name it.
        if response.status().as_u16() == 428 && previous.is_none() {
            if let RelayAnswer::Packet(current) = self.relay_get(url, &key).await {
                if current.timestamp() < packet.timestamp() {
                    response = send(Some(current.timestamp())).await.map_err(&failed)?;
                    self.note_rate_limit(url, &response);
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
            response = send(None).await.map_err(&failed)?;
            self.note_rate_limit(url, &response);
        }
        // 409, 412 and 428 are the relay working as it should; its rate limit and its own errors count against it.
        match response.status().as_u16() {
            429 => {
                self.with_budget(url, |budget| budget.rest());
                self.breaker(url, Some((Failure::Throttled, "rate limited (429)")));
            }
            status @ 500.. => self.breaker(url, Some((Failure::Error, &format!("HTTP {status}")))),
            _ => self.breaker(url, None),
        }
        match response.status().as_u16() {
            200..=299 => Ok(()),
            429 => Err("rate limited".into()),
            409 => Err("relay has a more recent packet".into()),
            428 => Err("relay is still putting another packet".into()),
            status => Err(format!("status {status}")),
        }
    }

    fn relay_answered(&self, url: &Url, answer: RelayAnswer) {
        match answer {
            RelayAnswer::Packet(packet) => {
                self.inner.state.lock().unwrap().keep(packet);
                self.breaker(url, None);
            }
            RelayAnswer::Missing => self.breaker(url, None),
            // A missing key times out (the relay is asking its DHT); that is not a reason to rest.
            RelayAnswer::Timeout => {}
            RelayAnswer::RateLimited => {
                self.with_budget(url, |budget| budget.rest());
                self.breaker(url, Some((Failure::Throttled, "rate limited (429)")));
            }
            RelayAnswer::Unreachable(reason) => {
                self.with_budget(url, |budget| budget.rest());
                diagnostics::log(&format!(
                    "pkarr relay {} unreachable: {}",
                    host(url),
                    brief(&reason)
                ));
                self.breaker(url, Some((Failure::Error, "no answer")));
            }
            RelayAnswer::Other(reason) => {
                diagnostics::log(&format!(
                    "pkarr relay {} answered oddly: {reason}",
                    host(url)
                ));
                let reason = if reason.starts_with("HTTP ") {
                    reason
                } else {
                    "invalid answer".to_string()
                };
                self.breaker(url, Some((Failure::Error, &reason)));
            }
        }
    }

    fn newest(&self, key: &PublicKey) -> Option<SignedPacket> {
        let mut state = self.inner.state.lock().unwrap();
        let seen = state.newest.get_mut(key)?;
        seen.read_at = Instant::now();
        Some(seen.packet.clone())
    }
}

fn key_url(relay: &Url, key: &PublicKey) -> Url {
    let mut url = relay.clone();
    if let Ok(mut segments) = url.path_segments_mut() {
        segments.pop_if_empty().push(&key.to_z32());
    }
    url
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
    /// Not resting nor left alone, and this client has reads left for it this minute: `reads_per_minute`
    /// until the relay said its own limit, half of that (within bounds) from then on. No cap stays no cap.
    fn available(&mut self, now: Instant, reads_per_minute: usize) -> bool {
        if self.resting_until.is_some_and(|until| until > now) || self.breaker.blocked(now) {
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

impl Breaker {
    /// Left alone: its wait is not over, or it is and the one probe is out.
    fn blocked(&self, now: Instant) -> bool {
        match self.open_until {
            Some(until) if until > now => true,
            Some(_) => self.probing,
            None => false,
        }
    }

    /// A request goes to the relay now: its probe, when the wait is over.
    fn begin(&mut self, now: Instant) {
        if self.open_until.is_some_and(|until| until <= now) {
            self.probing = true;
        }
    }

    /// The relay answered; says whether it had been left alone.
    fn succeeded(&mut self) -> bool {
        let recovered = self.open_until.is_some();
        *self = Breaker::default();
        recovered
    }

    /// The relay failed a request; returns how long it is left alone when that tripped it.
    fn failed(&mut self, now: Instant, kind: Failure, reason: &str) -> Option<Duration> {
        self.failures += 1;
        self.kind = Some(kind);
        self.reason = reason.to_string();
        if !self.probing && self.failures < BREAKER_THRESHOLD {
            return None;
        }
        let wait = BREAKER_BASE
            .saturating_mul(2u32.saturating_pow(self.trips))
            .min(BREAKER_MAX);
        self.open_until = Some(now + wait);
        self.trips += 1;
        self.failures = 0;
        self.probing = false;
        Some(wait)
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

/// `GHOSTLY_PKARR_DHT_BOOTSTRAP`, read: `None` when unset or empty, an error for anything but `ip:port`.
fn dht_bootstrap(list: Option<&str>) -> Result<Option<Vec<SocketAddrV4>>, String> {
    let nodes: Vec<&str> = list
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|node| !node.is_empty())
        .collect();
    if nodes.is_empty() {
        return Ok(None);
    }
    nodes
        .iter()
        .map(|node| {
            node.parse::<SocketAddrV4>()
                .map_err(|e| format!("GHOSTLY_PKARR_DHT_BOOTSTRAP: {node}: {e}"))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

/// Relay URLs from Settings; any that is not one is left out.
pub fn relay_urls(relays: &[String]) -> Vec<Url> {
    relays
        .iter()
        .filter_map(|relay| relay.trim().parse::<Url>().ok())
        .filter(|url| matches!(url.scheme(), "http" | "https"))
        .collect()
}

async fn finished(mut progress: watch::Receiver<u8>) {
    // An error means the lookup task is gone, which is finished too.
    let _ = progress.wait_for(|at| *at == DONE).await;
}

async fn answered(mut progress: watch::Receiver<u8>) {
    let _ = progress.wait_for(|at| *at >= ANSWERED).await;
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

#[cfg(test)]
mod direct {
    // covers: core.dht-direct, core.relay-breaker, settings.network.native-dht
    use super::*;
    use crate::test_support::{pkarr_client, pkarr_relay, Relay};
    use pkarr::Keypair;

    fn packet(keypair: &Keypair, value: &str) -> SignedPacket {
        SignedPacket::builder()
            .txt("_n".try_into().unwrap(), value.try_into().unwrap(), 300)
            .sign(keypair)
            .unwrap()
    }

    fn requests(relay: &Relay, method: &str) -> usize {
        let requests = relay.requests.lock().unwrap();
        requests.iter().filter(|r| r.starts_with(method)).count()
    }

    /// The app as it starts: the DHT (`dht` stands in for it) read directly, `relay` written to.
    fn native(relay: &Relay, dht: &Relay) -> Pkarr {
        Pkarr::direct(
            Dht::StandIn(pkarr_client(dht)),
            &[relay.url.parse().unwrap()],
        )
        .unwrap()
    }

    #[tokio::test]
    async fn reads_go_to_the_dht_alone_and_writes_reach_the_relays_too() {
        let (relay, dht) = (pkarr_relay().await, pkarr_relay().await);
        let pkarr = native(&relay, &dht);
        let keypair = Keypair::random();
        pkarr.publish(&packet(&keypair, "1")).await.unwrap();
        let key = keypair.public_key().to_z32();
        for _ in 0..20 {
            if relay.packets.lock().unwrap().contains_key(&key)
                && dht.packets.lock().unwrap().contains_key(&key)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            relay.packets.lock().unwrap().contains_key(&key),
            "browser contacts read the relays"
        );
        assert!(dht.packets.lock().unwrap().contains_key(&key));

        let reader = native(&relay, &dht);
        let got = reader.resolve(&keypair.public_key()).await.unwrap();
        assert_eq!(got.timestamp(), packet_timestamp(&dht, &key));
        assert_eq!(requests(&relay, "GET"), 0, "no read, no read-back");
        assert_eq!(
            reader.status().path,
            Some(Path::Dht),
            "the panel says DHT direct"
        );
    }

    fn packet_timestamp(relay: &Relay, key: &str) -> pkarr::Timestamp {
        let bytes = relay.packets.lock().unwrap().get(key).cloned().unwrap();
        let timestamp = u64::from_be_bytes(bytes[64..72].try_into().unwrap());
        pkarr::Timestamp::from(timestamp)
    }

    #[tokio::test]
    async fn a_read_of_a_new_key_waits_for_the_lookups_first_answer_and_no_longer() {
        let (relay, dht) = (pkarr_relay().await, pkarr_relay().await);
        let keypair = Keypair::random();
        dht.packets.lock().unwrap().insert(
            keypair.public_key().to_z32(),
            packet(&keypair, "1").to_relay_payload().to_vec(),
        );
        *dht.delay.lock().unwrap() = Duration::from_millis(300);
        let pkarr = native(&relay, &dht);
        let started = Instant::now();
        assert!(pkarr.resolve(&keypair.public_key()).await.is_some());
        assert!(
            started.elapsed() < DHT_ANSWER_WAIT,
            "{:?}",
            started.elapsed()
        );

        // A key nobody has: the read gives up after the wait, the lookup runs on.
        *dht.delay.lock().unwrap() = Duration::from_secs(3);
        let started = Instant::now();
        assert!(pkarr
            .resolve(&Keypair::random().public_key())
            .await
            .is_none());
        let took = started.elapsed();
        assert!(
            took >= DHT_ANSWER_WAIT && took < DHT_ANSWER_WAIT + Duration::from_millis(500),
            "{took:?}"
        );
    }

    #[tokio::test]
    async fn also_use_pkarr_relays_turns_relay_reads_on_and_off() {
        let (relay, dht) = (pkarr_relay().await, pkarr_relay().await);
        let keypair = Keypair::random();
        let first = packet(&keypair, "1");
        relay.packets.lock().unwrap().insert(
            keypair.public_key().to_z32(),
            first.to_relay_payload().to_vec(),
        );
        *dht.delay.lock().unwrap() = Duration::from_secs(2);
        let pkarr = native(&relay, &dht);
        pkarr.configure(vec![relay.url.parse().unwrap()], true);
        assert!(pkarr.resolve(&keypair.public_key()).await.is_some());
        assert_eq!(requests(&relay, "GET"), 1);
        assert_eq!(
            pkarr.status().path,
            Some(Path::Relay {
                relay: relay.url.clone()
            })
        );

        pkarr.configure(vec![relay.url.parse().unwrap()], false);
        pkarr.resolve(&keypair.public_key()).await;
        assert_eq!(requests(&relay, "GET"), 1, "off again: the DHT alone");
    }

    #[tokio::test]
    async fn settings_replace_the_relays_written_to_but_not_the_ones_the_environment_names() {
        let (a, b, dht) = (
            pkarr_relay().await,
            pkarr_relay().await,
            pkarr_relay().await,
        );
        let pkarr = native(&a, &dht);
        pkarr.configure(vec![b.url.parse().unwrap()], false);
        pkarr
            .publish(&packet(&Keypair::random(), "1"))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!((requests(&a, "PUT"), requests(&b, "PUT")), (0, 1));

        // GHOSTLY_PKARR_RELAYS alone: those relays are the network, read every time, whatever Settings say.
        let private = Pkarr::private(&[a.url.parse().unwrap()]).unwrap();
        private.configure(vec![b.url.parse().unwrap()], false);
        let keypair = Keypair::random();
        private.publish(&packet(&keypair, "1")).await.unwrap();
        assert!(private.resolve(&keypair.public_key()).await.is_some());
        assert_eq!(requests(&b, "PUT"), 1);
    }

    #[tokio::test]
    async fn a_relay_that_keeps_failing_trips_and_is_written_to_no_more_while_it_waits() {
        let (relay, dht) = (pkarr_relay().await, pkarr_relay().await);
        *relay.broken.lock().unwrap() = true;
        let pkarr = native(&relay, &dht);
        let keypair = Keypair::random();
        for i in 0..BREAKER_THRESHOLD {
            // The DHT write carries each publish.
            pkarr
                .publish(&packet(&keypair, &i.to_string()))
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_millis(1_100)).await;
        }
        let status = pkarr.status();
        assert_eq!(status.relays.len(), 1);
        assert_eq!(status.relays[0].state, "failing");
        assert_eq!(status.relays[0].reason.as_deref(), Some("HTTP 503"));
        let until = status.relays[0].until.unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        assert!(
            until > now + 55_000 && until <= now + 60_000,
            "{until} {now}"
        );
        let puts = requests(&relay, "PUT");
        pkarr.publish(&packet(&keypair, "more")).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(requests(&relay, "PUT"), puts, "left alone");
    }

    #[tokio::test]
    async fn with_relay_reads_on_the_dht_answers_while_every_relay_is_left_alone() {
        let (relay, dht) = (pkarr_relay().await, pkarr_relay().await);
        let keypair = Keypair::random();
        dht.packets.lock().unwrap().insert(
            keypair.public_key().to_z32(),
            packet(&keypair, "dht").to_relay_payload().to_vec(),
        );
        *relay.broken.lock().unwrap() = true;
        let pkarr = Pkarr::new(Some(pkarr_client(&dht)), &[relay.url.parse().unwrap()]).unwrap();
        for _ in 0..BREAKER_THRESHOLD {
            pkarr.resolve(&Keypair::random().public_key()).await;
        }
        let gets = requests(&relay, "GET");
        assert_eq!(gets, BREAKER_THRESHOLD as usize);
        assert!(pkarr.resolve(&keypair.public_key()).await.is_some());
        assert_eq!(requests(&relay, "GET"), gets, "tripped: not asked");
        assert_eq!(pkarr.status().path, Some(Path::Dht));
    }

    #[test]
    fn the_breaker_trips_waits_probes_and_recovers() {
        let mut breaker = Breaker::default();
        let t0 = Instant::now();
        for _ in 1..BREAKER_THRESHOLD {
            assert_eq!(breaker.failed(t0, Failure::Error, "no answer"), None);
        }
        assert!(!breaker.blocked(t0));
        assert_eq!(
            breaker.failed(t0, Failure::Error, "no answer"),
            Some(BREAKER_BASE)
        );
        assert!(breaker.blocked(t0 + BREAKER_BASE - Duration::from_millis(1)));
        let later = t0 + BREAKER_BASE;
        assert!(!breaker.blocked(later), "its wait is over: a probe may go");
        breaker.begin(later);
        assert!(breaker.blocked(later), "one probe at a time");
        // The probe failed: twice as long, then the cap.
        assert_eq!(
            breaker.failed(later, Failure::Throttled, "rate limited (429)"),
            Some(BREAKER_BASE * 2)
        );
        let mut at = later + BREAKER_BASE * 2;
        let mut waits = vec![];
        for _ in 0..4 {
            breaker.begin(at);
            let wait = breaker.failed(at, Failure::Error, "HTTP 502").unwrap();
            waits.push(wait.as_secs());
            at += wait;
        }
        assert_eq!(waits, [240, 300, 300, 300]);
        breaker.begin(at);
        assert!(breaker.succeeded(), "it had been left alone");
        assert!(!breaker.blocked(at));
        // An answer resets the backoff and the count.
        for _ in 0..BREAKER_THRESHOLD - 1 {
            breaker.failed(at, Failure::Error, "no answer");
        }
        assert!(
            !breaker.succeeded() && !breaker.blocked(at),
            "not tripped: nothing to recover from"
        );
        for _ in 0..BREAKER_THRESHOLD {
            breaker.failed(at, Failure::Error, "no answer");
        }
        assert!(breaker.blocked(at + BREAKER_BASE - Duration::from_millis(1)));
        assert!(!breaker.blocked(at + BREAKER_BASE));
    }

    #[tokio::test]
    async fn the_status_reads_as_packages_cores_discovery_status() {
        let (relay, dht) = (pkarr_relay().await, pkarr_relay().await);
        let pkarr = native(&relay, &dht);
        pkarr.resolve(&Keypair::random().public_key()).await;
        assert_eq!(
            serde_json::to_value(pkarr.status()).unwrap(),
            serde_json::json!({ "path": { "via": "dht" }, "relays": [{ "relay": relay.url, "state": "ok" }] })
        );
    }

    #[test]
    fn ghostly_pkarr_dht_bootstrap_is_a_comma_separated_list_of_addresses() {
        assert_eq!(dht_bootstrap(None).unwrap(), None);
        assert_eq!(dht_bootstrap(Some(" ")).unwrap(), None);
        assert_eq!(
            dht_bootstrap(Some("127.0.0.1:6881, 10.0.0.2:1"))
                .unwrap()
                .unwrap(),
            [
                "127.0.0.1:6881".parse::<SocketAddrV4>().unwrap(),
                "10.0.0.2:1".parse().unwrap()
            ]
        );
        assert!(dht_bootstrap(Some("router.example:6881"))
            .unwrap_err()
            .contains("GHOSTLY_PKARR_DHT_BOOTSTRAP"));
        assert_eq!(
            relay_urls(&[
                "https://relay.example".into(),
                "ftp://x".into(),
                "nonsense".into()
            ]),
            ["https://relay.example".parse::<Url>().unwrap()]
        );
    }

    /// The real thing in miniature: Mainline DHT nodes on this machine, two apps on it, no relay at all.
    #[tokio::test(flavor = "multi_thread")]
    async fn two_apps_find_each_other_on_a_mainline_dht_with_no_relay() {
        let testnet = mainline::Testnet::builder(8).build().unwrap();
        let bootstrap: Vec<SocketAddrV4> = testnet
            .bootstrap
            .iter()
            .map(|node| node.parse().unwrap())
            .collect();
        let app = || Pkarr::direct(Dht::mainline(Some(bootstrap.clone())).unwrap(), &[]).unwrap();
        let (alice, bob) = (app(), app());
        let keypair = Keypair::random();
        let hello = packet(&keypair, "hello");
        alice.publish(&hello).await.unwrap();
        let mut found = None;
        for _ in 0..10 {
            found = bob.resolve(&keypair.public_key()).await;
            if found.is_some() {
                break;
            }
        }
        assert_eq!(found.unwrap().timestamp(), hello.timestamp());
        assert_eq!(bob.status().path, Some(Path::Dht));
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

    /// DHT-direct timings, the numbers behind native's default: a publish, a reader's first answer and its
    /// full lookup, for a key another node published, and for a key nobody has; a relay read beside them.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "reaches the real DHT and relays"]
    async fn live_dht_direct_latency() {
        use pkarr::dht::{DhtClient, DhtConfig};
        let publisher = DhtClient::build(DhtConfig::default()).unwrap();
        let reader = DhtClient::build(DhtConfig::default()).unwrap();
        tokio::time::sleep(Duration::from_secs(3)).await; // the DHT nodes bootstrap
        let http = reqwest::Client::new();
        let (mut put, mut first, mut full, mut relay) = (vec![], vec![], vec![], vec![]);
        for round in 0..6 {
            let keypair = Keypair::random();
            let started = Instant::now();
            publisher
                .publish(&packet(&keypair, &round.to_string()))
                .await
                .unwrap();
            put.push(started.elapsed().as_secs_f64());
            let started = Instant::now();
            let response = reader.resolve(&keypair.public_key(), None).await;
            first.push(started.elapsed().as_secs_f64());
            let found = response.first().is_some();
            let outcome = response.complete().await;
            full.push(started.elapsed().as_secs_f64());
            println!(
                "round {round}: first answer {found}, most recent {}",
                outcome.most_recent.is_ok()
            );
            // The same key from a relay, which reads it off the DHT on a miss.
            let started = Instant::now();
            let status = http
                .get(format!(
                    "https://pkarr.pubky.app/{}",
                    keypair.public_key().to_z32()
                ))
                .send()
                .await
                .map(|r| r.status().as_u16())
                .unwrap_or(0);
            relay.push(started.elapsed().as_secs_f64());
            println!("round {round}: relay {status}");
        }
        line("DHT publish", &put);
        line("DHT read, first answer", &first);
        line("DHT read, complete", &full);
        line("relay read (pkarr.pubky.app)", &relay);
        let mut missing = vec![];
        for _ in 0..3 {
            let started = Instant::now();
            let response = reader.resolve(&Keypair::random().public_key(), None).await;
            assert!(response.first().is_none());
            missing.push(started.elapsed().as_secs_f64());
        }
        line("DHT read, missing key", &missing);

        // A link publishes one key again and again (presence, offer, answer): the closest nodes are known by then.
        let keypair = Keypair::random();
        let mut again = vec![];
        for round in 0..5 {
            let started = Instant::now();
            publisher
                .publish(&packet(&keypair, &format!("again {round}")))
                .await
                .unwrap();
            again.push(started.elapsed().as_secs_f64());
        }
        line("DHT publish, same key again", &again);
    }

    /// A web contact reads a DHT-direct peer through a relay: how long a relay that holds an older packet of
    /// the key takes to serve a newer one put on the DHT alone.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "reaches the real DHT and relays"]
    async fn live_relay_sees_a_dht_only_update() {
        use pkarr::dht::{DhtClient, DhtConfig};
        let publisher = DhtClient::build(DhtConfig::default()).unwrap();
        tokio::time::sleep(Duration::from_secs(3)).await;
        let http = reqwest::Client::new();
        let short_ttl = |keypair: &Keypair, value: &str| {
            SignedPacket::builder()
                .txt("_n".try_into().unwrap(), value.try_into().unwrap(), 1)
                .sign(keypair)
                .unwrap()
        };
        for relay in ["https://pkarr.pubky.app", "https://pkarr.pubky.org"] {
            let keypair = Keypair::random();
            let url = format!("{relay}/{}", keypair.public_key().to_z32());
            let read = || async {
                let response = http.get(&url).send().await.ok()?;
                let bytes = response.bytes().await.ok()?;
                SignedPacket::from_relay_payload(&keypair.public_key(), &bytes)
                    .ok()
                    .map(|p| p.timestamp().as_u64())
            };
            let first = short_ttl(&keypair, "1");
            publisher.publish(&first).await.unwrap();
            // The relay reads it off the DHT and keeps it.
            let started = Instant::now();
            let at = visible_after(started, first.timestamp().as_u64(), read).await;
            println!("{relay}: first DHT-only packet served after {at:.2} s");
            let newer = short_ttl(&keypair, "2");
            publisher.publish(&newer).await.unwrap();
            let started = Instant::now();
            let at = visible_after(started, newer.timestamp().as_u64(), read).await;
            println!(
                "{relay}: newer DHT-only packet served after {at:.2} s (30 = never within 30 s)"
            );
        }
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
