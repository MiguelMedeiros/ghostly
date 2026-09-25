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

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use pkarr::relay_client::{RelayClient, RelayError};
use pkarr::{Client, PublicKey, ResolvePolicy, SignedPacket};
use tokio::sync::watch;
use url::Url;

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

pub struct Pkarr {
    inner: Arc<Inner>,
}

struct Inner {
    /// Publishes, and looks keys up in the background. The DHT in the app.
    lookup: Option<Client>,
    relays: Vec<RelayClient>,
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
}

impl Pkarr {
    /// The app's: the DHT, and pkarr's default relays for reads and writes —
    /// or, when `GHOSTLY_PKARR_RELAYS` names some (comma-separated URLs), those
    /// relays alone: a private network, or the end-to-end tests' relay, which
    /// is how the scenario matrix pairs Desktop with its other peers offline.
    pub fn desktop() -> Result<Self, String> {
        if let Some(relays) = private_relays(std::env::var("GHOSTLY_PKARR_RELAYS").ok().as_deref())? {
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

    fn with_budget(lookup: Option<Client>, relays: &[Url], reads_per_minute: usize) -> Result<Self, String> {
        // The default reqwest client, as pkarr builds its own relay clients.
        let http = reqwest::Client::builder()
            .build()
            .map_err(|e| format!("HTTP client: {e}"))?;
        let relays = relays
            .iter()
            .map(|url| RelayClient::new(url.clone(), http.clone(), pkarr::DEFAULT_REQUEST_TIMEOUT))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Relay: {e}"))?;
        let state = State {
            relays: relays.iter().map(|_| RelayBudget::default()).collect(),
            ..State::default()
        };
        Ok(Self {
            inner: Arc::new(Inner {
                lookup,
                relays,
                reads_per_minute,
                state: Mutex::new(state),
            }),
        })
    }

    /// Publishes to the DHT and every relay; one of them taking it is enough.
    pub async fn publish(&self, packet: &SignedPacket) -> Result<(), String> {
        let inner = &self.inner;
        let relays =
            futures_util::future::join_all(inner.relays.iter().map(|relay| async move {
                relay.publish(packet).await.map_err(|e| e.to_string())
            }));
        let lookup = async {
            match &inner.lookup {
                Some(client) => Some(client.publish(packet).await.map_err(|e| e.to_string())),
                None => None,
            }
        };
        let (relays, lookup) = tokio::join!(relays, lookup);

        let results: Vec<_> = relays.into_iter().chain(lookup).collect();
        if results.iter().any(Result::is_ok) {
            return Ok(());
        }
        let reasons: Vec<_> = results.into_iter().filter_map(Result::err).collect();
        Err(format!("Publish error: {}", reasons.join("; ")))
    }

    /// The newest packet seen under `key`, having asked the network: `None`
    /// when nobody has published one anyone could find.
    pub async fn resolve(&self, key: &PublicKey) -> Option<SignedPacket> {
        let lookup = self.look_up(key);

        if let Some(index) = self.take_relay() {
            let read = self.inner.relays[index].resolve(key, ResolvePolicy::CacheFirst, None);
            tokio::pin!(read);
            let answer = match lookup.clone() {
                Some(done) => tokio::select! {
                    answer = &mut read => Some(answer),
                    _ = finished(done) => None,
                },
                None => Some(read.as_mut().await),
            };
            match answer {
                Some(answer) => self.relay_answered(index, answer),
                // The lookup was quicker. Only an empty handed one waits for the relay.
                None if self.newest(key).is_none() => self.relay_answered(index, read.await),
                None => {}
            }
        }

        if self.newest(key).is_none() {
            if let Some(done) = lookup {
                finished(done).await;
            }
        }
        self.newest(key)
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

    /// The next relay, in turn, that is not resting and has budget left.
    fn take_relay(&self) -> Option<usize> {
        let mut state = self.inner.state.lock().unwrap();
        let now = Instant::now();
        let count = state.relays.len();
        for _ in 0..count {
            let index = state.turn % count;
            state.turn = state.turn.wrapping_add(1);
            if state.relays[index].take(now, self.inner.reads_per_minute) {
                return Some(index);
            }
        }
        None
    }

    fn relay_answered(&self, index: usize, answer: Result<SignedPacket, RelayError>) {
        let mut state = self.inner.state.lock().unwrap();
        match answer {
            Ok(packet) => state.keep(packet),
            // A missing key times out: the relay is asking the DHT. Not a reason to rest.
            Err(RelayError::Request(_)) => state.relays[index].rest(),
            Err(RelayError::UnexpectedStatus(status)) if status.as_u16() == 429 => {
                state.relays[index].rest()
            }
            Err(_) => {}
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
    fn keep(&mut self, packet: SignedPacket) {
        let key = packet.public_key();
        if let Some(seen) = self.newest.get_mut(&key) {
            if packet.more_recent_than(&seen.packet) {
                seen.packet = packet;
            }
            return;
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
    }
}

impl RelayBudget {
    fn take(&mut self, now: Instant, reads_per_minute: usize) -> bool {
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
        if self.spent.len() >= reads_per_minute {
            return false;
        }
        self.spent.push_back(now);
        true
    }

    fn rest(&mut self) {
        self.resting_until = Some(Instant::now() + REST);
    }
}

/// `GHOSTLY_PKARR_RELAYS`, read: `None` when unset or empty, an error for a URL that is not one.
fn private_relays(list: Option<&str>) -> Result<Option<Vec<Url>>, String> {
    let urls: Vec<&str> = list.unwrap_or("").split(',').map(str::trim).filter(|url| !url.is_empty()).collect();
    if urls.is_empty() {
        return Ok(None);
    }
    urls.iter()
        .map(|url| url.parse::<Url>().map_err(|e| format!("GHOSTLY_PKARR_RELAYS: {url}: {e}")))
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
        let got = pkarr.resolve(&keypair.public_key()).await.unwrap();
        assert_eq!(value(&got), "dht");
        assert!(pkarr
            .resolve(&Keypair::random().public_key())
            .await
            .is_none());
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
            assert_eq!(value(&pkarr.resolve(&keypair.public_key()).await.unwrap()), "1");
        }
        // No budget: a private relay answers every poll, so a newer packet is seen at once.
        assert_eq!(gets(&relay), READS_PER_MINUTE + 10);
        tokio::time::sleep(Duration::from_millis(1_100)).await;
        pkarr.publish(&packet(&keypair, "2")).await.unwrap();
        assert_eq!(value(&pkarr.resolve(&keypair.public_key()).await.unwrap()), "2");
    }

    #[test]
    fn ghostly_pkarr_relays_is_a_comma_separated_list_of_urls() {
        assert_eq!(private_relays(None).unwrap(), None);
        assert_eq!(private_relays(Some(" , ")).unwrap(), None);
        let relays = private_relays(Some("http://127.0.0.1:1, http://127.0.0.1:2/")).unwrap().unwrap();
        assert_eq!(relays.iter().map(Url::as_str).collect::<Vec<_>>(), ["http://127.0.0.1:1/", "http://127.0.0.1:2/"]);
        assert!(private_relays(Some("not a url")).unwrap_err().contains("GHOSTLY_PKARR_RELAYS"));
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
    async fn a_packet_is_published_to_the_relays_and_the_dht_and_one_is_enough() {
        let (fast, dht) = (pkarr_relay().await, pkarr_relay().await);
        let keypair = Keypair::random();
        let key = keypair.public_key().to_z32();
        desktop(&fast, &dht)
            .publish(&packet(&keypair, "1"))
            .await
            .unwrap();
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
