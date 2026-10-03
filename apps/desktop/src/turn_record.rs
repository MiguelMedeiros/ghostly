//! The turn record's bytes (WISP 06, The turn, Record), as `packages/core/src/turnRecord.ts` writes and
//! reads them: the fixed binary body, its sequence number, its seal and the reader's rules.
//!
//! The Desktop's engine is the shared TypeScript one, running in the WebView: it signs, seals, opens and
//! judges every turn record, and this side only carries packets (`turn_network.rs`). This module is the
//! same format written a second time, compiled for the tests alone: both suites read
//! `packages/core/test/vectors/turn-record.json`, so a change to the bytes on either side fails the other.
//! The packet is canonical: this writer and the TypeScript one make the same bytes for the same record.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use crypto_secretbox::aead::{Aead, KeyInit};
use crypto_secretbox::XSalsa20Poly1305;
use pkarr::{Keypair, PublicKey};
use simple_dns::rdata::RData;

pub const SLOTS: usize = 4;
pub const NAME_BYTES: usize = 16;
pub const BODY_BYTES: usize = 374;
pub const SIGNED_BYTES: usize = 310;
pub const SEALED_BYTES: usize = 24 + BODY_BYTES + 16;
pub const TURN_MAX: u32 = u32::MAX - 1;
pub const TOMBSTONE_TURN: u32 = u32::MAX;
pub const REV_LIMIT: u32 = 1 << 18;
pub const TOMBSTONE_SEQUENCE: u64 = (1 << 52) - 1;
pub const NO_ACTIVE: u8 = 255;
pub const LABEL: &str = "_s";
pub const TTL: u32 = 300;

const SLOT_BYTES: usize = 32 + NAME_BYTES;
const AT_TURN: usize = 1;
const AT_REV: usize = 5;
const AT_AUTHOR: usize = 8;
const AT_ACTIVE: usize = 9;
const AT_COUNT: usize = 10;
const AT_SLOTS: usize = 11;
const AT_INSTANCE: usize = 203;
const AT_RELEASE: usize = 211;
const AT_RELEASE_H: usize = 214;
const AT_RELEASE_SIGNATURE: usize = 246;

/// The BEP44 sequence number of an ordinary record: `turn * 2^20 + rev * 4 + author`.
pub fn sequence(turn: u32, rev: u32, author: u8) -> Option<u64> {
    if turn > TURN_MAX || rev >= REV_LIMIT || author as usize >= SLOTS {
        return None;
    }
    Some(((turn as u64) << 20) + (rev as u64) * 4 + author as u64)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Slot {
    pub key: [u8; 32],
    pub name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Release {
    pub from: u8,
    pub to: u8,
    pub h: [u8; 32],
    pub signature: [u8; 64],
}

/// What a record says, before its author signs it.
#[derive(Debug, Clone, PartialEq)]
pub struct Fields {
    pub turn: u32,
    pub rev: u32,
    pub author: u8,
    pub active: u8,
    pub slots: [Option<Slot>; SLOTS],
    pub instance: [u8; 8],
    pub release: Option<Release>,
}

/// A record as read.
#[derive(Debug, Clone, PartialEq)]
pub struct Record {
    pub fields: Fields,
    pub tombstone: bool,
    pub sequence: u64,
}

/// Why the reader refuses a record: the names `TurnRefusal` has in TypeScript.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Refusal {
    Label,
    Seal,
    Length,
    Version,
    Rev,
    Author,
    Active,
    Count,
    Slots,
    Name,
    ReleaseLayout,
    Tombstone,
    AuthorNotActive,
    Signature,
    Release,
    Sequence,
}

impl Refusal {
    pub fn name(self) -> &'static str {
        match self {
            Refusal::Label => "label",
            Refusal::Seal => "seal",
            Refusal::Length => "length",
            Refusal::Version => "version",
            Refusal::Rev => "rev",
            Refusal::Author => "author",
            Refusal::Active => "active",
            Refusal::Count => "count",
            Refusal::Slots => "slots",
            Refusal::Name => "name",
            Refusal::ReleaseLayout => "release-layout",
            Refusal::Tombstone => "tombstone",
            Refusal::AuthorNotActive => "author-not-active",
            Refusal::Signature => "signature",
            Refusal::Release => "release",
            Refusal::Sequence => "sequence",
        }
    }
}

fn verifies(key: &[u8; 32], message: &[u8], signature: &[u8; 64]) -> bool {
    let Ok(key) = PublicKey::try_from(key) else {
        return false;
    };
    key.verify(message, &(*signature).into()).is_ok()
}

/// What a release signs: `"ghostly-turn-release" || turnAddress(32) || turn(4) || toKey(32) || H(32)`.
pub fn release_message(address: &[u8; 32], turn: u32, to_key: &[u8; 32], h: &[u8; 32]) -> Vec<u8> {
    [
        b"ghostly-turn-release".as_slice(),
        address,
        &turn.to_be_bytes(),
        to_key,
        h,
    ]
    .concat()
}

/// What the author signs: `"ghostly-turn" || turnAddress(32) || body[0..310]`.
pub fn signed_message(address: &[u8; 32], body: &[u8]) -> Vec<u8> {
    [b"ghostly-turn".as_slice(), address, &body[..SIGNED_BYTES]].concat()
}

/// The first 310 bytes of the body.
pub fn encode_fields(fields: &Fields) -> Vec<u8> {
    let mut body = vec![0u8; SIGNED_BYTES];
    body[0] = 1;
    body[AT_TURN..AT_TURN + 4].copy_from_slice(&fields.turn.to_be_bytes());
    body[AT_REV..AT_REV + 3].copy_from_slice(&fields.rev.to_be_bytes()[1..]);
    body[AT_AUTHOR] = fields.author;
    body[AT_ACTIVE] = fields.active;
    body[AT_COUNT] = fields.slots.iter().flatten().count() as u8;
    for (i, slot) in fields.slots.iter().enumerate() {
        if let Some(slot) = slot {
            let at = AT_SLOTS + i * SLOT_BYTES;
            body[at..at + 32].copy_from_slice(&slot.key);
            body[at + 32..at + 32 + slot.name.len()].copy_from_slice(slot.name.as_bytes());
        }
    }
    body[AT_INSTANCE..AT_INSTANCE + 8].copy_from_slice(&fields.instance);
    if let Some(release) = &fields.release {
        body[AT_RELEASE] = 1;
        body[AT_RELEASE + 1] = release.from;
        body[AT_RELEASE + 2] = release.to;
        body[AT_RELEASE_H..AT_RELEASE_H + 32].copy_from_slice(&release.h);
        body[AT_RELEASE_SIGNATURE..SIGNED_BYTES].copy_from_slice(&release.signature);
    }
    body
}

/// The whole body, 374 bytes: the fields and the author's signature over them.
pub fn sign_body(address: &[u8; 32], fields: &Fields, author: &Keypair) -> Vec<u8> {
    let mut body = encode_fields(fields);
    let signature = author.sign(&signed_message(address, &body));
    body.extend_from_slice(&signature.to_bytes());
    body
}

/// A body as a record, or the rule it breaks, in the order the TypeScript reader checks them.
pub fn read_body(body: &[u8], address: &[u8; 32]) -> Result<Record, Refusal> {
    if body.len() != BODY_BYTES {
        return Err(Refusal::Length);
    }
    if body[0] != 1 {
        return Err(Refusal::Version);
    }
    let turn = u32::from_be_bytes(body[AT_TURN..AT_TURN + 4].try_into().unwrap());
    let rev = u32::from_be_bytes([0, body[AT_REV], body[AT_REV + 1], body[AT_REV + 2]]);
    if rev >= REV_LIMIT {
        return Err(Refusal::Rev);
    }
    let (author, active, count) = (body[AT_AUTHOR], body[AT_ACTIVE], body[AT_COUNT]);
    if author as usize >= SLOTS {
        return Err(Refusal::Author);
    }
    if active as usize >= SLOTS && active != NO_ACTIVE {
        return Err(Refusal::Active);
    }
    if count as usize > SLOTS {
        return Err(Refusal::Count);
    }

    let mut slots: [Option<Slot>; SLOTS] = [None, None, None, None];
    for i in 0..SLOTS {
        let at = AT_SLOTS + i * SLOT_BYTES;
        let key: [u8; 32] = body[at..at + 32].try_into().unwrap();
        let padded = &body[at + 32..at + SLOT_BYTES];
        if key == [0u8; 32] {
            // An unused slot is zero, name and all.
            if padded.iter().any(|b| *b != 0) {
                return Err(Refusal::Slots);
            }
            continue;
        }
        let end = padded.iter().position(|b| *b == 0).unwrap_or(NAME_BYTES);
        if padded[end..].iter().any(|b| *b != 0) {
            return Err(Refusal::Name);
        }
        let name = std::str::from_utf8(&padded[..end]).map_err(|_| Refusal::Name)?;
        if slots.iter().flatten().any(|other| other.key == key) {
            return Err(Refusal::Slots);
        }
        slots[i] = Some(Slot {
            key,
            name: name.to_string(),
        });
    }
    if slots.iter().flatten().count() != count as usize {
        return Err(Refusal::Count);
    }
    let Some(author_key) = slots[author as usize].as_ref().map(|slot| slot.key) else {
        return Err(Refusal::Author);
    };

    let tombstone = turn == TOMBSTONE_TURN;
    if tombstone != (active == NO_ACTIVE) {
        return Err(Refusal::Tombstone);
    }
    if !tombstone {
        if slots[active as usize].is_none() {
            return Err(Refusal::Active);
        }
        // A record is written by the device it names active.
        if author != active {
            return Err(Refusal::AuthorNotActive);
        }
    }

    let present = body[AT_RELEASE];
    if present > 1 {
        return Err(Refusal::ReleaseLayout);
    }
    let mut release = None;
    if present == 0 {
        if body[AT_RELEASE + 1..SIGNED_BYTES].iter().any(|b| *b != 0) {
            return Err(Refusal::ReleaseLayout);
        }
    } else {
        if tombstone {
            return Err(Refusal::Tombstone);
        }
        let (from, to) = (body[AT_RELEASE + 1], body[AT_RELEASE + 2]);
        let key_of = |slot: u8| {
            slots
                .get(slot as usize)
                .and_then(|slot| slot.as_ref())
                .map(|slot| slot.key)
        };
        let (Some(from_key), Some(to_key)) = (key_of(from), key_of(to)) else {
            return Err(Refusal::ReleaseLayout);
        };
        let h: [u8; 32] = body[AT_RELEASE_H..AT_RELEASE_SIGNATURE].try_into().unwrap();
        let signature: [u8; 64] = body[AT_RELEASE_SIGNATURE..SIGNED_BYTES].try_into().unwrap();
        if to != active {
            return Err(Refusal::Release);
        }
        if !verifies(
            &from_key,
            &release_message(address, turn, &to_key, &h),
            &signature,
        ) {
            return Err(Refusal::Release);
        }
        release = Some(Release {
            from,
            to,
            h,
            signature,
        });
    }

    let signature: [u8; 64] = body[SIGNED_BYTES..].try_into().unwrap();
    if !verifies(&author_key, &signed_message(address, body), &signature) {
        return Err(Refusal::Signature);
    }
    let sequence = if tombstone {
        TOMBSTONE_SEQUENCE
    } else {
        sequence(turn, rev, author).ok_or(Refusal::Sequence)?
    };
    Ok(Record {
        fields: Fields {
            turn,
            rev,
            author,
            active,
            slots,
            instance: body[AT_INSTANCE..AT_RELEASE].try_into().unwrap(),
            release,
        },
        tombstone,
        sequence,
    })
}

/// The TXT value: base64url of `nonce(24) || XSalsa20-Poly1305(sealKey, nonce, body)`.
pub fn seal(body: &[u8], seal_key: &[u8; 32], nonce: &[u8; 24]) -> String {
    let cipher = XSalsa20Poly1305::new(seal_key.into());
    let sealed = cipher.encrypt(nonce.into(), body).expect("sealing");
    URL_SAFE_NO_PAD.encode([nonce.as_slice(), &sealed].concat())
}

/// The body inside a TXT value, or `None` when it does not open under the seal key.
pub fn open(value: &str, seal_key: &[u8; 32]) -> Option<Vec<u8>> {
    let sealed = URL_SAFE_NO_PAD.decode(value).ok()?;
    if sealed.len() != SEALED_BYTES {
        return None;
    }
    let cipher = XSalsa20Poly1305::new(seal_key.into());
    let nonce: &[u8; 24] = sealed[..24].try_into().ok()?;
    cipher.decrypt(nonce.into(), &sealed[24..]).ok()
}

/// The canonical DNS packet of a TXT value (WISP 06, Record, "The packet is canonical"): one answer, the
/// name `_s.<turn key in z-base-32>` with no compression, class IN, type TXT, TTL 300, and the value cut
/// into strings of 255 bytes with the rest last. `simple-dns` cuts at 254, so the packet is written here.
pub fn dns_packet(turn_key_z32: &str, value: &str) -> Vec<u8> {
    // No id, a reply, no question, one answer, no other section.
    let mut dns = vec![0, 0, 0x80, 0, 0, 0, 0, 1, 0, 0, 0, 0];
    for label in [LABEL, turn_key_z32] {
        dns.push(label.len() as u8);
        dns.extend_from_slice(label.as_bytes());
    }
    dns.push(0);
    dns.extend_from_slice(&[0, 16, 0, 1]);
    dns.extend_from_slice(&TTL.to_be_bytes());
    let strings: Vec<u8> = value
        .as_bytes()
        .chunks(255)
        .flat_map(|chunk| std::iter::once(chunk.len() as u8).chain(chunk.iter().copied()))
        .collect();
    dns.extend_from_slice(&(strings.len() as u16).to_be_bytes());
    dns.extend_from_slice(&strings);
    dns
}

/// The packet of a signed body, as a relay payload (`signature || sequence || DNS packet`), signed under the
/// turn key at the record's own sequence: the canonical packet, byte for byte what the TypeScript writer makes.
pub fn packet(turn_key: &Keypair, seal_key: &[u8; 32], body: &[u8], nonce: &[u8; 24]) -> Vec<u8> {
    let address = turn_key.public_key().to_bytes();
    let record = read_body(body, &address).expect("a valid body");
    let dns = dns_packet(
        &turn_key.public_key().to_z32(),
        &seal(body, seal_key, nonce),
    );
    let signable = [
        format!("3:seqi{}e1:v{}:", record.sequence, dns.len()).as_bytes(),
        &dns,
    ]
    .concat();
    [
        turn_key.sign(&signable).to_bytes().as_slice(),
        &record.sequence.to_be_bytes(),
        &dns,
    ]
    .concat()
}

/// A packet read at the turn address: a valid record, a packet a node stores that is no record (its
/// sequence still counts as seen), or nothing under the turn key at all.
#[derive(Debug, PartialEq)]
pub enum PacketRead {
    Valid(Record),
    Invalid { sequence: u64, refusal: Refusal },
    Foreign,
}

pub fn read_packet(address: &[u8; 32], seal_key: &[u8; 32], payload: &[u8]) -> PacketRead {
    // A BEP44 item: a signature, a sequence, and a value of at most 1000 bytes. One that does not verify
    // under the turn key, or that no node would store, is no packet at all.
    if payload.len() < 72 + 12 || payload.len() > 72 + 1000 {
        return PacketRead::Foreign;
    }
    let signature: [u8; 64] = payload[..64].try_into().unwrap();
    let sequence = u64::from_be_bytes(payload[64..72].try_into().unwrap());
    let value = &payload[72..];
    let signable = [
        format!("3:seqi{sequence}e1:v{}:", value.len()).as_bytes(),
        value,
    ]
    .concat();
    if !verifies(address, &signable, &signature) {
        return PacketRead::Foreign;
    }
    let invalid = |refusal| PacketRead::Invalid { sequence, refusal };
    // Exactly one answer, a TXT record under `_s`, and nothing else: no question, no other section, no
    // other record, no byte after it (simple-dns would read past a trailing byte and drop an OPT record).
    let count = |at: usize| u16::from_be_bytes([value[at], value[at + 1]]);
    if count(4) != 0 || count(6) != 1 || count(8) != 0 || count(10) != 0 {
        return invalid(Refusal::Label);
    }
    let Some(end) = single_record_end(value) else {
        return invalid(Refusal::Label);
    };
    if end != value.len() {
        return invalid(Refusal::Label);
    }
    let Ok(packet) = simple_dns::Packet::parse(value) else {
        return invalid(Refusal::Label);
    };
    let Ok(key) = PublicKey::try_from(address) else {
        return PacketRead::Foreign;
    };
    let name = format!("{LABEL}.{}", key.to_z32());
    let [record] = packet.answers.as_slice() else {
        return invalid(Refusal::Label);
    };
    if record.name.to_string().trim_end_matches('.') != name {
        return invalid(Refusal::Label);
    }
    let RData::TXT(txt) = &record.rdata else {
        return invalid(Refusal::Label);
    };
    let Ok(text) = String::try_from(txt.clone()) else {
        return invalid(Refusal::Label);
    };
    let Some(body) = open(&text, seal_key) else {
        return invalid(Refusal::Seal);
    };
    match read_body(&body, address) {
        Err(refusal) => invalid(refusal),
        Ok(record) if record.sequence != sequence => invalid(Refusal::Sequence),
        Ok(record) => PacketRead::Valid(record),
    }
}

/// Where the one record of a DNS packet with no question ends: its name (labels, or a pointer), type,
/// class, TTL, length and data. `None` when it runs past the packet.
fn single_record_end(dns: &[u8]) -> Option<usize> {
    let mut at = 12;
    loop {
        let length = *dns.get(at)? as usize;
        if length == 0 {
            at += 1;
            break;
        }
        if length & 0xc0 == 0xc0 {
            at += 2;
            break;
        }
        at += 1 + length;
    }
    let data = u16::from_be_bytes([*dns.get(at + 8)?, *dns.get(at + 9)?]) as usize;
    let end = at + 10 + data;
    (end <= dns.len()).then_some(end)
}

#[cfg(test)]
mod tests {
    // covers: devices.turn.record
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct SlotVector {
        key: String,
        name: String,
    }
    #[derive(Deserialize)]
    struct ReleaseVector {
        from: u8,
        to: u8,
        h: String,
        signature: String,
    }
    #[derive(Deserialize)]
    struct RecordVector {
        name: String,
        turn: u32,
        rev: u32,
        author: u8,
        active: u8,
        slots: Vec<Option<SlotVector>>,
        instance: String,
        release: Option<ReleaseVector>,
        nonce: String,
        sequence: String,
        body: String,
        value: String,
        payload: String,
    }
    #[derive(Deserialize)]
    struct InvalidVector {
        name: String,
        refusal: String,
        payload: String,
    }
    #[derive(Deserialize)]
    struct DeviceVector {
        seed: String,
        key: String,
    }
    #[derive(Deserialize)]
    struct SequenceVector {
        turn: u32,
        rev: u32,
        author: u8,
        sequence: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vectors {
        turn_seed: String,
        address: String,
        address_z32: String,
        seal_key: String,
        devices: Vec<DeviceVector>,
        sequences: Vec<SequenceVector>,
        records: Vec<RecordVector>,
        invalid: Vec<InvalidVector>,
    }

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect()
    }
    fn to_hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
    fn array<const N: usize>(text: &str) -> [u8; N] {
        hex(text).try_into().unwrap()
    }

    /// The file the TypeScript suite builds and checks: `packages/core/test/vectors/turn-record.json`.
    fn vectors() -> Vectors {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/core/test/vectors/turn-record.json"
        );
        serde_json::from_str(&std::fs::read_to_string(path).expect("the shared vectors file"))
            .expect("the vectors' shape")
    }

    fn fields_of(vector: &RecordVector) -> Fields {
        let mut slots: [Option<Slot>; SLOTS] = [None, None, None, None];
        for (i, slot) in vector.slots.iter().enumerate() {
            slots[i] = slot.as_ref().map(|slot| Slot {
                key: array(&slot.key),
                name: slot.name.clone(),
            });
        }
        Fields {
            turn: vector.turn,
            rev: vector.rev,
            author: vector.author,
            active: vector.active,
            slots,
            instance: array(&vector.instance),
            release: vector.release.as_ref().map(|release| Release {
                from: release.from,
                to: release.to,
                h: array(&release.h),
                signature: array(&release.signature),
            }),
        }
    }

    #[test]
    fn the_keys_in_the_vectors_are_the_ones_these_seeds_give() {
        let v = vectors();
        let turn_key = Keypair::from_secret_key(&array(&v.turn_seed));
        assert_eq!(to_hex(&turn_key.public_key().to_bytes()), v.address);
        assert_eq!(turn_key.public_key().to_z32(), v.address_z32);
        for device in &v.devices {
            let pair = Keypair::from_secret_key(&array(&device.seed));
            assert_eq!(to_hex(&pair.public_key().to_bytes()), device.key);
        }
    }

    #[test]
    fn every_record_is_written_byte_for_byte_as_typescript_writes_it() {
        let v = vectors();
        let turn_key = Keypair::from_secret_key(&array(&v.turn_seed));
        let (address, seal_key): ([u8; 32], [u8; 32]) = (array(&v.address), array(&v.seal_key));
        assert_eq!(v.records.len(), 7);
        for vector in &v.records {
            let fields = fields_of(vector);
            let author = Keypair::from_secret_key(&array(&v.devices[vector.author as usize].seed));
            // The release is signed by the device that gave the turn up, over the same message.
            if let Some(release) = &fields.release {
                let from = Keypair::from_secret_key(&array(&v.devices[release.from as usize].seed));
                let to_key = fields.slots[release.to as usize].as_ref().unwrap().key;
                let message = release_message(&address, fields.turn, &to_key, &release.h);
                assert_eq!(
                    from.sign(&message).to_bytes(),
                    release.signature,
                    "{}",
                    vector.name
                );
            }
            let body = sign_body(&address, &fields, &author);
            assert_eq!(to_hex(&body), vector.body, "{}", vector.name);
            assert_eq!(body.len(), BODY_BYTES);
            let nonce: [u8; 24] = array(&vector.nonce);
            assert_eq!(
                seal(&body, &seal_key, &nonce),
                vector.value,
                "{}",
                vector.name
            );
            assert_eq!(vector.value.len(), 552);
            // The canonical packet: the whole payload is the one the TypeScript writer makes.
            assert_eq!(
                to_hex(&packet(&turn_key, &seal_key, &body, &nonce)),
                vector.payload,
                "{}",
                vector.name
            );
        }
    }

    #[test]
    fn every_record_reads_back_as_what_was_written_at_the_formulas_sequence() {
        let v = vectors();
        let (address, seal_key): ([u8; 32], [u8; 32]) = (array(&v.address), array(&v.seal_key));
        for vector in &v.records {
            let payload = hex(&vector.payload);
            let PacketRead::Valid(record) = read_packet(&address, &seal_key, &payload) else {
                panic!("{} is not read as valid", vector.name);
            };
            assert_eq!(record.fields, fields_of(vector), "{}", vector.name);
            assert_eq!(
                record.sequence.to_string(),
                vector.sequence,
                "{}",
                vector.name
            );
            assert_eq!(record.tombstone, vector.turn == TOMBSTONE_TURN);
            assert_eq!(open(&vector.value, &seal_key).unwrap(), hex(&vector.body));
            assert_eq!(
                read_body(&hex(&vector.body), &address).unwrap(),
                record,
                "{}",
                vector.name
            );
        }
        let tombstone = v.records.last().unwrap();
        assert_eq!(tombstone.sequence, TOMBSTONE_SEQUENCE.to_string());
        assert_eq!(tombstone.active, NO_ACTIVE);
    }

    #[test]
    fn the_reader_refuses_every_invalid_packet_for_the_rule_typescript_names() {
        let v = vectors();
        let (address, seal_key): ([u8; 32], [u8; 32]) = (array(&v.address), array(&v.seal_key));
        assert!(v.invalid.len() >= 38);
        for vector in &v.invalid {
            let payload = hex(&vector.payload);
            let refusal = match read_packet(&address, &seal_key, &payload) {
                PacketRead::Valid(_) => "valid",
                PacketRead::Foreign => "foreign",
                PacketRead::Invalid { sequence, refusal } => {
                    // The sequence a node sorts by is the packet's, whatever it holds.
                    let raw = u64::from_be_bytes(payload[64..72].try_into().unwrap());
                    assert_eq!(sequence, raw, "{}", vector.name);
                    refusal.name()
                }
            };
            assert_eq!(refusal, vector.refusal, "{}", vector.name);
        }
    }

    #[test]
    fn the_sequence_formula_and_its_bounds() {
        for vector in &vectors().sequences {
            let got = sequence(vector.turn, vector.rev, vector.author).unwrap();
            assert_eq!(got.to_string(), vector.sequence);
        }
        assert_eq!(sequence(TOMBSTONE_TURN, 0, 0), None);
        assert_eq!(sequence(1, REV_LIMIT, 0), None);
        assert_eq!(sequence(1, 0, 4), None);
        assert!(sequence(TURN_MAX, REV_LIMIT - 1, 3).unwrap() < TOMBSTONE_SEQUENCE);
        // The slot is in the low bits: two devices never sign an equal sequence.
        assert_eq!(sequence(5, 9, 2).unwrap() - sequence(5, 9, 1).unwrap(), 1);
        assert!(sequence(5, 0, 0).unwrap() > sequence(4, REV_LIMIT - 1, 3).unwrap());
    }

    #[test]
    fn a_body_of_another_length_is_refused_before_anything_is_read() {
        let address = [7u8; 32];
        assert_eq!(
            read_body(&[1u8; BODY_BYTES - 1], &address),
            Err(Refusal::Length)
        );
        assert_eq!(read_body(&[], &address), Err(Refusal::Length));
        assert_eq!(open("AAAA", &[1u8; 32]), None);
        assert_eq!(
            read_packet(&address, &[1u8; 32], &[0u8; 80]),
            PacketRead::Foreign
        );
    }
}
