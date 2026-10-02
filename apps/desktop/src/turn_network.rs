//! The turn record's own way to the network (WISP 06, The turn, Publishing and reading), for the shared
//! TypeScript engine in the WebView: every source is read, and every put is conditional.
//!
//! The chat path next door (`pkarr_network.rs`) is wrong for the turn in four ways: it reads until the first
//! source answers, it calls a put done when one source took it, it sends a refused conditional put again
//! without its condition, and its DHT publish passes no compare-and-swap value. So nothing here goes through
//! it, and nothing there changes: other records publish as they did.
//!
//! - A read asks the DHT itself and every relay, at once, `SOURCE_TIMEOUT` each, and hands back each
//!   source's answer as it came: every distinct item the DHT's nodes returned, the one packet a relay holds.
//!   Nothing is kept, and nothing is answered from memory.
//! - A put sends the bytes as given to each source the caller names, on that source's own condition: `cas`
//!   on the DHT, `If-Match` on a relay. Each source's answer is reported. A refusal (301 or 302 from a node,
//!   409, 412 or 428 from a relay) is an answer, never tried again.
//!
//! The DHT side needs `put_mutable` with a `cas`, which `pkarr`'s `DhtClient` does not offer (its `publish`
//! passes `None`, and its node is private). So the turn has a Mainline node of its own, made at its first
//! use: a profile on one device never makes one.

use std::collections::HashMap;
use std::net::SocketAddrV4;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use futures_util::StreamExt;
use mainline::async_dht::AsyncDht;
use mainline::errors::{ConcurrencyError, PutMutableError, PutQueryError};
use mainline::MutableItem;
use pkarr::PublicKey;
use serde::Serialize;
use tokio::sync::OnceCell;
use url::Url;

/// How long each source has to answer a read or a put.
const SOURCE_TIMEOUT: Duration = Duration::from_secs(8);
/// A relay's body, at most (as `pkarr_network.rs`).
const MAX_BODY: usize = 4096;
/// Distinct items kept from one DHT read: honest nodes hold one or two (the newest, and one being replaced).
const MAX_ITEMS: usize = 16;
/// The DHT's name as a source. A relay's is its URL.
pub const DHT_SOURCE: &str = "dht";
/// On a relay's 404: the sequence of an item the DHT holds under the key that is no signed packet.
const INVALID_PACKET_SEQ: &str = "pkarr-invalid-signed-packet-seq";

/// The turn's own Mainline node: made at the first turn read or put, never before.
pub struct TurnDht {
    bootstrap: Option<Vec<SocketAddrV4>>,
    node: OnceCell<AsyncDht>,
}

impl TurnDht {
    pub fn new(bootstrap: Option<Vec<SocketAddrV4>>) -> Self {
        Self {
            bootstrap,
            node: OnceCell::new(),
        }
    }

    async fn node(&self) -> Result<&AsyncDht, String> {
        self.node
            .get_or_try_init(|| async {
                let mut builder = mainline::Dht::builder();
                if let Some(bootstrap) = &self.bootstrap {
                    builder.bootstrap(bootstrap);
                }
                builder
                    .build()
                    .map(|dht| dht.as_async())
                    .map_err(|e| format!("DHT node: {e}"))
            })
            .await
    }

    /// Whether the node was made: a profile on one device leaves it unmade.
    #[cfg(test)]
    fn started(&self) -> bool {
        self.node.initialized()
    }
}

/// Where the turn is read and put: the DHT (the Desktop app has one) and the relays of Settings.
pub struct TurnSources<'a> {
    pub dht: Option<&'a TurnDht>,
    pub relays: Vec<Url>,
    pub http: &'a reqwest::Client,
}

/// One source's answer to a read, as packages/core's `TurnSourceAnswer`.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct SourceAnswer {
    pub source: String,
    pub answered: bool,
    /// Relay payloads (`signature || sequence || value`), base64url.
    pub payloads: Vec<String>,
    /// Sequences the source reports without handing the item over (a relay, for an item that is no signed packet).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sequences: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// One source's answer to a put, as packages/core's `TurnSourcePut`: `stored`, `refused` or `failed`.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct SourcePut {
    pub source: String,
    pub outcome: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// A relay's URL as Settings and the browser clients write it: no trailing slash.
fn plain(url: &Url) -> String {
    url.as_str().trim_end_matches('/').to_string()
}

fn key_url(relay: &Url, key: &PublicKey, query: Option<&str>) -> Url {
    let mut url = relay.clone();
    if let Ok(mut segments) = url.path_segments_mut() {
        segments.pop_if_empty().push(&key.to_z32());
    }
    url.set_query(query);
    url
}

fn silent(source: String, detail: impl Into<String>) -> SourceAnswer {
    SourceAnswer {
        source,
        answered: false,
        payloads: vec![],
        sequences: vec![],
        detail: Some(detail.into()),
    }
}

/// A mutable item as the relay payload a reader verifies: `signature(64) || sequence(8) || value`.
fn payload_of(item: &MutableItem) -> Vec<u8> {
    let mut payload = Vec::with_capacity(72 + item.value().len());
    payload.extend_from_slice(item.signature());
    payload.extend_from_slice(&(item.seq() as u64).to_be_bytes());
    payload.extend_from_slice(item.value());
    payload
}

/// A relay payload as the mutable item a node stores. The signature is the caller's: a node checks it.
fn item_of(key: &PublicKey, payload: &[u8]) -> Result<MutableItem, String> {
    if payload.len() <= 72 {
        return Err("a packet is a signature, a sequence and a value".into());
    }
    let signature: [u8; 64] = payload[..64].try_into().unwrap();
    let sequence = u64::from_be_bytes(payload[64..72].try_into().unwrap());
    let sequence = i64::try_from(sequence).map_err(|_| "a sequence above 2^63 - 1")?;
    Ok(MutableItem::new_signed_unchecked(
        key.to_bytes(),
        signature,
        &payload[72..],
        sequence,
        None,
    ))
}

async fn read_dht(dht: &TurnDht, key: &PublicKey) -> SourceAnswer {
    let source = DHT_SOURCE.to_string();
    let node = match dht.node().await {
        Ok(node) => node,
        Err(e) => return silent(source, e),
    };
    let mut detailed = node.get_mutable_detailed(key.as_bytes(), None, None);
    let mut payloads: Vec<Vec<u8>> = Vec::new();
    let collect = async {
        while let Some(item) = detailed.items.next().await {
            let payload = payload_of(&item);
            if !payloads.contains(&payload) && payloads.len() < MAX_ITEMS {
                payloads.push(payload);
            }
        }
        detailed.outcome.recv().await
    };
    let outcome = tokio::time::timeout(SOURCE_TIMEOUT, collect).await;
    // A node that returned an item answered, whatever became of the rest of the lookup.
    let answered = !payloads.is_empty() || outcome.is_ok_and(|outcome| outcome.responded() > 0);
    if !answered {
        return silent(source, "no node answered");
    }
    SourceAnswer {
        source,
        answered: true,
        payloads: payloads
            .iter()
            .map(|payload| URL_SAFE_NO_PAD.encode(payload))
            .collect(),
        sequences: vec![],
        detail: None,
    }
}

async fn read_relay(http: &reqwest::Client, relay: &Url, key: &PublicKey) -> SourceAnswer {
    let source = plain(relay);
    // A relay answers a plain GET from its cache while the packet's TTL lasts: a record another device put
    // elsewhere would not be seen. `NetworkOnly` makes it look; a relay from before that query refuses it (400).
    let mut response = match get(http, key_url(relay, key, Some("policy=NetworkOnly"))).await {
        Ok(response) => response,
        Err(e) => return silent(source, e),
    };
    if response.status().as_u16() == 400 {
        response = match get(http, key_url(relay, key, None)).await {
            Ok(response) => response,
            Err(e) => return silent(source, e),
        };
    }
    match response.status().as_u16() {
        404 => {
            let sequences = response
                .headers()
                .get(INVALID_PACKET_SEQ)
                .and_then(|value| value.to_str().ok())
                .filter(|text| text.parse::<u64>().is_ok())
                .map(|text| vec![text.to_string()])
                .unwrap_or_default();
            SourceAnswer {
                source,
                answered: true,
                payloads: vec![],
                sequences,
                detail: None,
            }
        }
        200 => {
            if response
                .content_length()
                .is_some_and(|len| len > MAX_BODY as u64)
            {
                return silent(source, "body too large");
            }
            match response.bytes().await {
                Ok(bytes) if bytes.len() <= MAX_BODY => SourceAnswer {
                    source,
                    answered: true,
                    payloads: vec![URL_SAFE_NO_PAD.encode(&bytes)],
                    sequences: vec![],
                    detail: None,
                },
                Ok(_) => silent(source, "body too large"),
                Err(e) => silent(source, e.to_string()),
            }
        }
        status => silent(source, format!("HTTP {status}")),
    }
}

async fn get(http: &reqwest::Client, url: Url) -> Result<reqwest::Response, String> {
    http.get(url)
        .timeout(SOURCE_TIMEOUT)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "timed out".to_string()
            } else {
                e.to_string()
            }
        })
}

/// Reads the turn record at `key` from every source, at once. One answer per source, the DHT first.
pub async fn read(sources: &TurnSources<'_>, key: &PublicKey) -> Vec<SourceAnswer> {
    let dht = async {
        match sources.dht {
            Some(dht) => Some(read_dht(dht, key).await),
            None => None,
        }
    };
    let relays = futures_util::future::join_all(
        sources
            .relays
            .iter()
            .map(|relay| read_relay(sources.http, relay, key)),
    );
    let (dht, relays) = tokio::join!(dht, relays);
    dht.into_iter().chain(relays).collect()
}

async fn put_dht(dht: &TurnDht, key: &PublicKey, payload: &[u8], cas: Option<i64>) -> SourcePut {
    let put = |outcome, detail: String| SourcePut {
        source: DHT_SOURCE.to_string(),
        outcome,
        detail: Some(detail),
    };
    let item = match item_of(key, payload) {
        Ok(item) => item,
        Err(e) => return put("failed", e),
    };
    let node = match dht.node().await {
        Ok(node) => node,
        Err(e) => return put("failed", e),
    };
    match tokio::time::timeout(SOURCE_TIMEOUT, node.put_mutable(item, cas)).await {
        Err(_) => put("failed", "timed out".into()),
        Ok(Ok(outcome)) => put("stored", format!("{} nodes", outcome.stored_at)),
        // Someone else wrote: a lower or equal sequence (302), or a `cas` that names another one (301).
        Ok(Err(PutMutableError::Concurrency(error))) => put(
            "refused",
            match error {
                ConcurrencyError::CasFailed => "301".into(),
                ConcurrencyError::NotMostRecent => "302".into(),
                ConcurrencyError::ConflictRisk => "a put of this key is in flight".into(),
            },
        ),
        Ok(Err(PutMutableError::Query(PutQueryError::ErrorResponse(error))))
            if error.code == 301 || error.code == 302 =>
        {
            put("refused", error.code.to_string())
        }
        Ok(Err(PutMutableError::Query(error))) => put("failed", error.to_string()),
    }
}

async fn put_relay(
    http: &reqwest::Client,
    relay: &Url,
    key: &PublicKey,
    payload: &[u8],
    replaces: Option<&str>,
) -> SourcePut {
    let source = plain(relay);
    let mut request = http
        .put(key_url(relay, key, None))
        .timeout(SOURCE_TIMEOUT)
        .body(payload.to_vec());
    if let Some(sequence) = replaces {
        request = request.header("If-Match", sequence);
    }
    match request.send().await {
        Err(e) => SourcePut {
            source,
            outcome: "failed",
            detail: Some(if e.is_timeout() {
                "timed out".into()
            } else {
                e.to_string()
            }),
        },
        Ok(response) => {
            let status = response.status();
            let outcome = if status.is_success() {
                "stored"
            } else if matches!(status.as_u16(), 409 | 412 | 428) {
                // Someone else wrote. Never sent again without the condition.
                "refused"
            } else {
                "failed"
            };
            SourcePut {
                source,
                outcome,
                detail: Some(format!("HTTP {}", status.as_u16())),
            }
        }
    }
}

/// Puts `payload` at `key` on each source `conditions` names, on that source's condition: the sequence it
/// is known to hold (decimal text), or `None` where it held no record. A source that is not named is not
/// put to. Every source's answer comes back, the DHT's first.
pub async fn put(
    sources: &TurnSources<'_>,
    key: &PublicKey,
    payload: &[u8],
    conditions: &HashMap<String, Option<String>>,
) -> Result<Vec<SourcePut>, String> {
    let dht_condition = match conditions.get(DHT_SOURCE) {
        None => None,
        Some(None) => Some(None),
        Some(Some(text)) => Some(Some(
            text.parse::<i64>()
                .map_err(|_| format!("not a sequence: {text}"))?,
        )),
    };
    let dht = async {
        match (sources.dht, dht_condition) {
            (Some(dht), Some(cas)) => Some(put_dht(dht, key, payload, cas).await),
            _ => None,
        }
    };
    let relays = futures_util::future::join_all(sources.relays.iter().filter_map(|relay| {
        let condition = conditions.get(&plain(relay))?;
        Some(put_relay(
            sources.http,
            relay,
            key,
            payload,
            condition.as_deref(),
        ))
    }));
    let (dht, relays) = tokio::join!(dht, relays);
    Ok(dht.into_iter().chain(relays).collect())
}

#[cfg(test)]
mod tests {
    // covers: devices.turn.read
    use super::*;
    use crate::pkarr_network::{Dht, Pkarr};
    use crate::test_support::{closed_port, pkarr_relay, Relay};
    use crate::turn_record::{self, Fields, Slot};
    use pkarr::{Keypair, SignedPacket};

    /// A Mainline DHT of a few nodes on this machine.
    fn testnet() -> (mainline::Testnet, Vec<SocketAddrV4>) {
        let testnet = mainline::Testnet::builder(8).build().unwrap();
        let bootstrap = testnet
            .bootstrap
            .iter()
            .map(|node| node.parse().unwrap())
            .collect();
        (testnet, bootstrap)
    }

    /// The app on that DHT, writing to `relays`.
    fn app(bootstrap: &[SocketAddrV4], relays: &[&Relay]) -> Pkarr {
        let urls: Vec<Url> = relays
            .iter()
            .map(|relay| relay.url.parse().unwrap())
            .collect();
        Pkarr::direct(Dht::mainline(Some(bootstrap.to_vec())).unwrap(), &urls).unwrap()
    }

    struct Set {
        turn: Keypair,
        seal: [u8; 32],
        device: Keypair,
    }
    impl Set {
        fn new() -> Self {
            Self {
                turn: Keypair::random(),
                seal: [9u8; 32],
                device: Keypair::random(),
            }
        }
        fn key(&self) -> PublicKey {
            self.turn.public_key()
        }
        /// A turn record by the one device, as the engine in the WebView would hand it over.
        fn record(&self, turn: u32, rev: u32, instance: u8) -> Vec<u8> {
            let fields = Fields {
                turn,
                rev,
                author: 0,
                active: 0,
                slots: [
                    Some(Slot {
                        key: self.device.public_key().to_bytes(),
                        name: "Desktop".into(),
                    }),
                    None,
                    None,
                    None,
                ],
                instance: [instance; 8],
                release: None,
            };
            let address = self.key().to_bytes();
            let body = turn_record::sign_body(&address, &fields, &self.device);
            turn_record::packet(&self.turn, &self.seal, &body, &[instance; 24])
        }
    }

    fn sequence_of(payload: &[u8]) -> String {
        u64::from_be_bytes(payload[64..72].try_into().unwrap()).to_string()
    }
    fn conditions(pairs: &[(&str, Option<&str>)]) -> HashMap<String, Option<String>> {
        pairs
            .iter()
            .map(|(source, condition)| (source.to_string(), condition.map(str::to_string)))
            .collect()
    }
    fn held(answer: &SourceAnswer) -> Vec<Vec<u8>> {
        answer
            .payloads
            .iter()
            .map(|payload| URL_SAFE_NO_PAD.decode(payload).unwrap())
            .collect()
    }
    /// The PUTs a relay saw, each as its condition (`if-match=<sequence>`, or nothing).
    fn puts(relay: &Relay) -> Vec<String> {
        let requests = relay.requests.lock().unwrap();
        requests
            .iter()
            .filter(|request| request.starts_with("PUT"))
            .map(|request| request.split(' ').skip(2).collect::<Vec<_>>().join(" "))
            .collect()
    }
    fn outcomes(puts: &[SourcePut]) -> Vec<&'static str> {
        puts.iter().map(|put| put.outcome).collect()
    }
    /// Whether the DHT comes to answer `payload` (nodes take a moment).
    async fn dht_holds(pkarr: &Pkarr, key: &PublicKey, payload: &[u8]) -> bool {
        for _ in 0..20 {
            let answers = read(&pkarr.turn_sources(), key).await;
            if held(&answers[0]).iter().any(|item| item == payload) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        false
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn every_source_is_read_and_each_answer_is_reported() {
        let (_testnet, bootstrap) = testnet();
        let (relay, broken) = (pkarr_relay().await, pkarr_relay().await);
        let pkarr = app(&bootstrap, &[&relay, &broken]);
        let set = Set::new();
        let key = set.key();

        // Nothing there yet: the DHT and the working relay answer that they hold nothing.
        *broken.broken.lock().unwrap() = true;
        let empty = read(&pkarr.turn_sources(), &key).await;
        assert_eq!(empty.len(), 3, "the DHT and both relays");
        assert_eq!(empty[0].source, DHT_SOURCE);
        assert!(empty[0].answered && empty[0].payloads.is_empty());
        assert_eq!(empty[1].source, relay.url);
        assert!(empty[1].answered && empty[1].payloads.is_empty());
        assert!(!empty[2].answered, "a relay that is broken did not answer");
        assert_eq!(empty[2].detail.as_deref(), Some("HTTP 503"));
        // The relay is asked to look on the network, not in its cache.
        let asked = relay.requests.lock().unwrap().clone();
        assert_eq!(asked, [format!("GET /{}?policy=NetworkOnly", key.to_z32())]);

        // The first record: no condition anywhere, since no source held anything.
        let first = set.record(40, 0, 1);
        let all = conditions(&[(DHT_SOURCE, None), (&relay.url, None), (&broken.url, None)]);
        let stored = put(&pkarr.turn_sources(), &key, &first, &all)
            .await
            .unwrap();
        assert_eq!(
            outcomes(&stored),
            ["stored", "stored", "failed"],
            "{stored:?}"
        );
        assert!(dht_holds(&pkarr, &key, &first).await);
        let answers = read(&pkarr.turn_sources(), &key).await;
        assert_eq!(held(&answers[1]), [first.clone()], "the bytes as put");
        assert!(!answers[2].answered);

        // Another device, on the DHT alone, reads the same bytes.
        let other = app(&bootstrap, &[]);
        assert!(dht_holds(&other, &key, &first).await);
        assert_eq!(read(&other.turn_sources(), &key).await.len(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_put_is_conditional_on_each_source_and_a_refusal_is_never_sent_again_without_it() {
        let (_testnet, bootstrap) = testnet();
        let relay = pkarr_relay().await;
        let pkarr = app(&bootstrap, &[&relay]);
        let set = Set::new();
        let key = set.key();
        let (first, second, third) = (
            set.record(40, 0, 1),
            set.record(40, 1, 1),
            set.record(40, 2, 1),
        );
        let both = |condition: Option<&str>| {
            conditions(&[(DHT_SOURCE, condition), (&relay.url, condition)])
        };

        let stored = put(&pkarr.turn_sources(), &key, &first, &both(None))
            .await
            .unwrap();
        assert_eq!(outcomes(&stored), ["stored", "stored"]);
        assert!(dht_holds(&pkarr, &key, &first).await);

        // The next record, on the sequence it replaces: `cas` on the DHT, `If-Match` on the relay.
        let held_first = sequence_of(&first);
        let stored = put(
            &pkarr.turn_sources(),
            &key,
            &second,
            &both(Some(&held_first)),
        )
        .await
        .unwrap();
        assert_eq!(outcomes(&stored), ["stored", "stored"], "{stored:?}");
        assert!(dht_holds(&pkarr, &key, &second).await);

        // A device that still believes the first record is there: its put names a sequence nobody holds.
        let stale = app(&bootstrap, &[&relay]);
        assert!(dht_holds(&stale, &key, &second).await);
        let before = puts(&relay).len();
        let refused = put(
            &stale.turn_sources(),
            &key,
            &third,
            &both(Some(&held_first)),
        )
        .await
        .unwrap();
        assert_eq!(outcomes(&refused), ["refused", "refused"], "{refused:?}");
        assert_eq!(refused[0].detail.as_deref(), Some("301"), "the DHT's cas");
        assert_eq!(refused[1].detail.as_deref(), Some("HTTP 412"));
        // One request to the relay, with its condition. The chat path would send it again bare.
        assert_eq!(puts(&relay)[before..], [format!("if-match={held_first}")]);
        // And both sources still hold the second record.
        let answers = read(&pkarr.turn_sources(), &key).await;
        assert!(!held(&answers[0]).contains(&third));
        assert!(held(&answers[0]).contains(&second));
        assert_eq!(held(&answers[1]), [second.clone()]);

        // A lower sequence is refused whatever the condition: a stale device learns it was replaced.
        let lower = put(&stale.turn_sources(), &key, &first, &both(None))
            .await
            .unwrap();
        assert_eq!(outcomes(&lower), ["refused", "refused"], "{lower:?}");
        assert_eq!(lower[0].detail.as_deref(), Some("302"));
        assert_eq!(lower[1].detail.as_deref(), Some("HTTP 409"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_source_that_is_not_named_is_not_put_to() {
        let (_testnet, bootstrap) = testnet();
        let relay = pkarr_relay().await;
        let pkarr = app(&bootstrap, &[&relay]);
        let set = Set::new();
        let first = set.record(40, 0, 1);
        // The relay did not answer the read: only the DHT is named.
        let only_dht = conditions(&[(DHT_SOURCE, None)]);
        let stored = put(&pkarr.turn_sources(), &set.key(), &first, &only_dht)
            .await
            .unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].source, DHT_SOURCE);
        assert!(puts(&relay).is_empty());
        // A condition that is no sequence is refused before anything is sent.
        let bad = conditions(&[(DHT_SOURCE, Some("soon"))]);
        assert!(put(&pkarr.turn_sources(), &set.key(), &first, &bad)
            .await
            .is_err());
    }

    /// The measurement of WISP 06: a different packet at an equal sequence, on Mainline nodes.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_different_packet_at_an_equal_sequence_on_the_dht() {
        let (_testnet, bootstrap) = testnet();
        let (one, two) = (app(&bootstrap, &[]), app(&bootstrap, &[]));
        let set = Set::new();
        let key = set.key();
        let (a, b) = (set.record(40, 1, 1), set.record(40, 1, 2));
        assert_eq!(sequence_of(&a), sequence_of(&b));
        let none = conditions(&[(DHT_SOURCE, None)]);
        let first = put(&one.turn_sources(), &key, &a, &none).await.unwrap();
        assert_eq!(outcomes(&first), ["stored"]);
        assert!(dht_holds(&one, &key, &a).await);
        // From another device, with no condition: accepted, and it replaces the first. At an equal sequence the
        // DHT is no lock.
        let second = put(&two.turn_sources(), &key, &b, &none).await.unwrap();
        assert_eq!(outcomes(&second), ["stored"], "{second:?}");
        assert!(dht_holds(&one, &key, &b).await);
        // With the condition a writer that read `a` sends, too: `cas` names the sequence, which did not change.
        // So nothing but the readers' own rule (the lower `instance` goes on) settles two packets at one sequence.
        let c = set.record(40, 1, 3);
        let with_cas = conditions(&[(DHT_SOURCE, Some(&sequence_of(&a)))]);
        let third = put(&two.turn_sources(), &key, &c, &with_cas).await.unwrap();
        assert_eq!(outcomes(&third), ["stored"], "{third:?}");
        assert!(dht_holds(&one, &key, &c).await);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn other_records_never_start_the_turn_s_node_and_a_silent_dht_did_not_answer() {
        let nowhere: SocketAddrV4 = format!("127.0.0.1:{}", closed_port()).parse().unwrap();
        let relay = pkarr_relay().await;
        let pkarr = Pkarr::direct(
            Dht::mainline(Some(vec![nowhere])).unwrap(),
            &[relay.url.parse().unwrap()],
        )
        .unwrap();
        // A profile on one device publishes its chats' records as before: the turn's node is not made.
        let chat = Keypair::random();
        let packet = SignedPacket::builder()
            .txt("_n".try_into().unwrap(), "1".try_into().unwrap(), 300)
            .sign(&chat)
            .unwrap();
        let _ = pkarr.publish(&packet).await;
        let _ = pkarr.resolve(&chat.public_key()).await;
        assert!(!pkarr.turn_sources().dht.unwrap().started());
        // That record went out as it always did: with no condition.
        assert_eq!(puts(&relay), [""]);

        let set = Set::new();
        let answers = read(&pkarr.turn_sources(), &set.key()).await;
        assert!(!answers[0].answered, "{answers:?}");
        assert!(answers[1].answered);
        assert!(pkarr.turn_sources().dht.unwrap().started());
        // Relays alone (no DHT in this app): the relays are the sources.
        let private = Pkarr::private(&[relay.url.parse().unwrap()]).unwrap();
        let answers = read(&private.turn_sources(), &set.key()).await;
        assert_eq!(answers.len(), 1);
        assert_eq!(answers[0].source, relay.url);
    }
}
