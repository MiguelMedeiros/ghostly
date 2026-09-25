//! The `ghostly-cli` binary: its arguments, its JSON, its exit codes. Only the
//! commands that never touch the network.

// covers: cli.identity, cli.invite, cli.send

use std::io::Write;
use std::process::{Command, Output, Stdio};

use serde_json::Value;

fn cli(args: &[&str]) -> Output {
    run(args, None)
}

fn run(args: &[&str], stdin: Option<&str>) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_ghostly-cli"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    if let Some(text) = stdin {
        input.write_all(text.as_bytes()).unwrap();
    }
    drop(input);
    child.wait_with_output().unwrap()
}

fn json(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes)
        .unwrap_or_else(|_| panic!("not JSON: {:?}", String::from_utf8_lossy(bytes)))
}

/// Exits 0 with one JSON value on stdout; a failure shows the exit code and stderr.
fn ok(output: Output) -> Value {
    assert!(
        output.status.success(),
        "exit {:?}, stderr: {}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );
    json(&output.stdout)
}

/// Exits 1 with `{"error": ...}` on stderr and nothing on stdout.
fn error(output: Output) -> String {
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    json(&output.stderr)["error"].as_str().unwrap().to_string()
}

#[test]
fn identity_new_prints_one_json_identity() {
    let identity = ok(cli(&["identity", "new"]));
    assert_eq!(identity["seed"].as_str().unwrap().len(), 43);
    assert_eq!(identity["pubkey"].as_str().unwrap().len(), 52);
    assert_eq!(identity["shared_key"].as_str().unwrap().len(), 43);
}

#[test]
fn an_invite_goes_out_and_comes_back() {
    let identity = ok(cli(&["identity", "new"]));
    let (seed, pubkey, key) = (
        identity["seed"].as_str().unwrap(),
        identity["pubkey"].as_str().unwrap(),
        identity["shared_key"].as_str().unwrap(),
    );
    let invite = ok(cli(&["invite", "new", "--seed", seed, "--key", key]));
    let url = format!("ghost://{pubkey}#{key}");
    assert_eq!(invite["invite_url"], url.as_str());
    assert_eq!(invite["pubkey"], pubkey);

    // Without --key, a fresh one.
    let fresh = ok(cli(&["invite", "new", "--seed", seed]));
    let fresh_url = fresh["invite_url"].as_str().unwrap();
    assert!(fresh_url.starts_with(&format!("ghost://{pubkey}#")));
    assert_ne!(fresh_url, url);

    let parsed = ok(cli(&["invite", "parse", &url]));
    assert_eq!(parsed["peer_pubkey"], pubkey);
    assert_eq!(parsed["shared_key"], key);
    assert_ne!(parsed["my_pubkey"], pubkey);
}

// Base64url has `-` in its alphabet, so about one seed or key in 64 starts
// with it. Clap used to read such a value as a flag (usage error, exit 2),
// which made `an_invite_goes_out_and_comes_back` fail a few % of runs.
const HYPHEN_SEED: &str = "-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const HYPHEN_KEY: &str = "-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_-_A";

#[test]
fn seeds_and_keys_may_start_with_a_hyphen() {
    let invite = ok(cli(&[
        "invite",
        "new",
        "--seed",
        HYPHEN_SEED,
        "--key",
        HYPHEN_KEY,
    ]));
    let pubkey = invite["pubkey"].as_str().unwrap();
    let url = format!("ghost://{pubkey}#{HYPHEN_KEY}");
    assert_eq!(invite["invite_url"], url.as_str());

    let seed = format!("--seed={HYPHEN_SEED}");
    let key = format!("--key={HYPHEN_KEY}");
    assert_eq!(ok(cli(&["invite", "new", &seed, &key])), invite);
    let fresh = ok(cli(&["invite", "new", "--seed", HYPHEN_SEED]));
    assert_eq!(fresh["pubkey"], pubkey);

    let parsed = ok(cli(&["invite", "parse", &url]));
    assert_eq!(parsed["peer_pubkey"], pubkey);
    assert_eq!(parsed["shared_key"], HYPHEN_KEY);

    // Whatever the value, it reaches the CLI's own checks: a JSON error, not a
    // usage error. Each of these fails before any network call.
    assert_eq!(
        error(cli(&["invite", "parse", "-ghost://x#y"])),
        "Invalid invite URL: must start with ghost://"
    );
    assert!(error(cli(&["invite", "new", "--seed", "-x"])).contains("Base64url decode failed"));
    assert_eq!(
        error(cli(&[
            "send",
            "--seed",
            HYPHEN_SEED,
            "--peer",
            "-p",
            "--key",
            HYPHEN_KEY
        ])),
        "Message required (provide as argument or use --stdin)"
    );
    assert!(
        error(cli(&["recv", "--peer", "-p", "--key", "-x"])).contains("Base64url decode failed")
    );
    assert!(error(cli(&[
        "watch", "--seed", "-x", "--peer", "-p", "--key", HYPHEN_KEY
    ]))
    .contains("Base64url decode failed"));
}

#[test]
fn a_message_that_starts_with_a_hyphen_goes_after_double_dash() {
    // The message stays a plain positional, so a mistyped flag is a usage
    // error rather than text sent to the peer.
    let send = ["send", "--seed", "s", "--peer", "p", "--key", "k"];
    let mut typo = send.to_vec();
    typo.push("--stdn");
    assert_eq!(cli(&typo).status.code(), Some(2));
    let mut dashed = send.to_vec();
    dashed.extend(["--", "-hi"]);
    assert!(error(cli(&dashed)).contains("Base64url decode failed"));
}

#[test]
fn bad_input_is_a_json_error_and_exit_code_1() {
    assert!(error(cli(&["invite", "new", "--seed", "short"])).contains("Base64url decode failed"));
    assert_eq!(
        error(cli(&["invite", "parse", "https://example.com"])),
        "Invalid invite URL: must start with ghost://"
    );
    assert_eq!(
        error(cli(&["invite", "parse", "ghost://only-a-key"])),
        "Invalid invite URL: missing # separator"
    );
    let send = ["send", "--seed", "s", "--peer", "p", "--key", "k"];
    assert_eq!(
        error(cli(&send)),
        "Message required (provide as argument or use --stdin)"
    );
    let mut from_stdin = send.to_vec();
    from_stdin.push("--stdin");
    assert_eq!(
        error(run(&from_stdin, Some("   \n"))),
        "Message cannot be empty"
    );
}

#[test]
fn missing_or_unknown_arguments_are_usage_errors() {
    for args in [
        &["send", "--peer", "p", "--key", "k", "hi"][..],
        &["recv", "--peer", "p"],
        &[
            "watch",
            "--seed",
            "s",
            "--peer",
            "p",
            "--key",
            "k",
            "--poll-interval",
            "soon",
        ],
        &["invite"],
        &["dance"],
        &[],
    ] {
        let output = cli(args);
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert!(output.stdout.is_empty(), "{args:?}");
    }
}

#[test]
fn says_its_version() {
    let output = cli(&["--version"]);
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        format!("ghostly-cli {}", env!("CARGO_PKG_VERSION"))
    );
}
