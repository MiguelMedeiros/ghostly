//! The library the CLI is built on, end to end against a relay held in memory.

// covers: cli.identity, cli.invite, cli.send, cli.recv, chat.dht.delivery, invite.code

mod support;

use ghostly::{
    from_base64_url, generate_invite, keypair_from_seed, new_identity, parse_invite,
    pubkey_from_seed, to_base64_url, GhostClient,
};

#[test]
fn an_identity_is_a_seed_its_public_key_and_a_fresh_shared_key() {
    let identity = new_identity();
    assert_eq!(from_base64_url(&identity.seed).unwrap().len(), 32);
    assert_eq!(from_base64_url(&identity.shared_key).unwrap().len(), 32);
    assert_eq!(pubkey_from_seed(&identity.seed).unwrap(), identity.pubkey);
    assert_eq!(identity.pubkey.len(), 52);
    let other = new_identity();
    assert_ne!(other.seed, identity.seed);
    assert_ne!(other.shared_key, identity.shared_key);
}

#[test]
fn a_seed_is_exactly_32_bytes_of_base64url() {
    for seed in [
        String::new(),
        "not base64!".into(),
        to_base64_url(&[1; 31]),
        to_base64_url(&[1; 33]),
    ] {
        assert!(keypair_from_seed(&seed).is_err(), "{seed}");
    }
    assert_eq!(
        keypair_from_seed(&to_base64_url(&[1; 31])).unwrap_err(),
        "Invalid seed length: expected 32 bytes, got 31"
    );
}

#[test]
fn an_invite_carries_the_public_key_and_the_shared_key() {
    let alice = new_identity();
    let invite = generate_invite(&alice.seed, &alice.shared_key).unwrap();
    assert_eq!(invite.pubkey, alice.pubkey);
    assert_eq!(
        invite.invite_url,
        format!("ghost://{}#{}", alice.pubkey, alice.shared_key)
    );

    let parsed = parse_invite(&invite.invite_url).unwrap();
    assert_eq!(parsed.peer_pubkey, alice.pubkey);
    assert_eq!(parsed.shared_key, alice.shared_key);
    // Whoever parses it gets an identity of their own.
    assert_eq!(pubkey_from_seed(&parsed.my_seed).unwrap(), parsed.my_pubkey);
    assert_ne!(parsed.my_pubkey, alice.pubkey);

    assert!(generate_invite("bad seed", &alice.shared_key).is_err());
    assert_eq!(
        parse_invite("https://example.com/#x").unwrap_err(),
        "Invalid invite URL: must start with ghost://"
    );
    // The app's invite is named as such, bare, as a link or in capitals (as a QR holds it).
    for code in [
        "ghostly1pqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccryd",
        "https://ghostly.tools/#ghostly1pqqqsyqcyq5rqwzqfpg9scrgwpugpzysnz",
        "HTTPS://GHOSTLY.TOOLS/#GHOSTLY1PQQQSYQCYQ5RQWZQFPG9SCRGWPUG",
        "https://app.ghostly.tools/#/chat/ghostly1pqqqsyqcyq5rqw",
    ] {
        assert_eq!(parse_invite(code).unwrap_err(), ghostly::APP_INVITE_ERROR);
    }
    for url in ["ghost://abc", "ghost://a#b#c"] {
        assert_eq!(
            parse_invite(url).unwrap_err(),
            "Invalid invite URL: missing # separator"
        );
    }
}

#[tokio::test]
async fn two_bots_talk_through_the_relay_and_acknowledge_each_other() {
    let relay = support::relay().await;
    let alice = new_identity();
    let bob = new_identity();
    let key = alice.shared_key.clone();
    let alice_client = GhostClient::with_client(support::client(&relay));
    let bob_client = GhostClient::with_client(support::client(&relay));

    let sent = alice_client
        .send(&alice.seed, &bob.pubkey, &key, "hello bob", Some("alice"))
        .await
        .unwrap();
    assert!(sent.ok);
    assert_eq!(sent.messages_kept, 1);
    assert!(relay.packets.lock().unwrap().contains_key(&alice.pubkey));

    let heard = bob_client.recv(&alice.pubkey, &key).await.unwrap();
    assert_eq!(heard.message_count, 1);
    assert_eq!(heard.messages[0].text, "hello bob");
    assert_eq!(heard.messages[0].nick.as_deref(), Some("alice"));
    assert_eq!(heard.messages[0].timestamp, sent.timestamp);
    assert_eq!((heard.latest_ts, heard.peer_ack), (sent.timestamp, 0));

    // Bob's reply acknowledges what he read of Alice's.
    bob_client
        .send(&bob.seed, &alice.pubkey, &key, "hi alice", None)
        .await
        .unwrap();
    let reply = alice_client.recv(&bob.pubkey, &key).await.unwrap();
    assert_eq!(reply.messages[0].text, "hi alice");
    assert_eq!(reply.messages[0].nick, None);
    assert_eq!(reply.peer_ack, sent.timestamp);

    // A send publishes that one message: the packet before it is replaced.
    alice_client
        .send(&alice.seed, &bob.pubkey, &key, "second", None)
        .await
        .unwrap();
    let heard = bob_client.recv(&alice.pubkey, &key).await.unwrap();
    let texts: Vec<_> = heard.messages.iter().map(|m| m.text.as_str()).collect();
    assert_eq!(texts, ["second"]);
}

#[tokio::test]
async fn nothing_is_read_without_the_shared_key_or_from_a_stranger() {
    let relay = support::relay().await;
    let alice = new_identity();
    let client = GhostClient::with_client(support::client(&relay));
    client
        .send(
            &alice.seed,
            &new_identity().pubkey,
            &alice.shared_key,
            "secret",
            None,
        )
        .await
        .unwrap();

    let other_key = new_identity().shared_key;
    let overheard = client.recv(&alice.pubkey, &other_key).await.unwrap();
    assert!(overheard.messages.is_empty());
    assert_eq!(overheard.message_count, 0);

    let silence = client
        .recv(&new_identity().pubkey, &alice.shared_key)
        .await
        .unwrap();
    assert_eq!(
        (silence.messages.len(), silence.latest_ts, silence.peer_ack),
        (0, 0, 0)
    );

    assert!(client
        .recv("not-a-key", &alice.shared_key)
        .await
        .unwrap_err()
        .contains("Invalid public key"));
    assert!(client.recv(&alice.pubkey, "not base64!").await.is_err());
    assert!(client
        .send("bad seed", &alice.pubkey, &alice.shared_key, "x", None)
        .await
        .is_err());
    // A key of the wrong length cannot seal anything.
    assert!(client
        .send(
            &alice.seed,
            &alice.pubkey,
            &to_base64_url(&[0; 16]),
            "x",
            None
        )
        .await
        .unwrap_err()
        .contains("Invalid key length"));
}

#[tokio::test]
async fn a_long_message_is_cut_to_fit_one_record() {
    let relay = support::relay().await;
    let alice = new_identity();
    let client = GhostClient::with_client(support::client(&relay));
    let long = "y".repeat(2_000);
    client
        .send(&alice.seed, &alice.pubkey, &alice.shared_key, &long, None)
        .await
        .unwrap();
    let heard = client.recv(&alice.pubkey, &alice.shared_key).await.unwrap();
    assert_eq!(heard.messages[0].text, "y".repeat(400));
}

#[tokio::test]
async fn a_long_message_in_any_script_is_cut_until_it_fits() {
    let relay = support::relay().await;
    let alice = new_identity();
    let client = GhostClient::with_client(support::client(&relay));
    for text in ["é".repeat(2_000), "👻".repeat(2_000), "\"".repeat(2_000)] {
        client
            .send(&alice.seed, &alice.pubkey, &alice.shared_key, &text, None)
            .await
            .unwrap_or_else(|error| panic!("{}: {error}", &text[..4]));
        let heard = client.recv(&alice.pubkey, &alice.shared_key).await.unwrap();
        let got = &heard.messages[0].text;
        assert!(!got.is_empty() && text.starts_with(got.as_str()), "{got}");
    }
}
