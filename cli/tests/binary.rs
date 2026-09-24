//! The `ghostly-cli` binary: its arguments, its JSON, its exit codes. Only the
//! commands that never touch the network.

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
    serde_json::from_slice(bytes).unwrap_or_else(|_| panic!("{}", String::from_utf8_lossy(bytes)))
}

/// Exits 1 with `{"error": ...}` on stderr and nothing on stdout.
fn error(output: Output) -> String {
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    json(&output.stderr)["error"].as_str().unwrap().to_string()
}

#[test]
fn identity_new_prints_one_json_identity() {
    let output = cli(&["identity", "new"]);
    assert!(output.status.success());
    let identity = json(&output.stdout);
    assert_eq!(identity["seed"].as_str().unwrap().len(), 43);
    assert_eq!(identity["pubkey"].as_str().unwrap().len(), 52);
    assert_eq!(identity["shared_key"].as_str().unwrap().len(), 43);
}

#[test]
fn an_invite_goes_out_and_comes_back() {
    let identity = json(&cli(&["identity", "new"]).stdout);
    let (seed, pubkey, key) = (
        identity["seed"].as_str().unwrap(),
        identity["pubkey"].as_str().unwrap(),
        identity["shared_key"].as_str().unwrap(),
    );
    let invite = json(&cli(&["invite", "new", "--seed", seed, "--key", key]).stdout);
    let url = format!("ghost://{pubkey}#{key}");
    assert_eq!(invite["invite_url"], url.as_str());
    assert_eq!(invite["pubkey"], pubkey);

    // Without --key, a fresh one.
    let fresh = json(&cli(&["invite", "new", "--seed", seed]).stdout);
    let fresh_url = fresh["invite_url"].as_str().unwrap();
    assert!(fresh_url.starts_with(&format!("ghost://{pubkey}#")));
    assert_ne!(fresh_url, url);

    let parsed = json(&cli(&["invite", "parse", &url]).stdout);
    assert_eq!(parsed["peer_pubkey"], pubkey);
    assert_eq!(parsed["shared_key"], key);
    assert_ne!(parsed["my_pubkey"], pubkey);
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
