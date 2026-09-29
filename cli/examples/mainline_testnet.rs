//! A Mainline DHT of a few nodes on 127.0.0.1, for the Desktop end-to-end tests (`GHOSTLY_PKARR_DHT_BOOTSTRAP`):
//! prints the bootstrap addresses as one comma-separated line, then runs until its standard input closes.
//!
//! `cargo run --manifest-path cli/Cargo.toml --example mainline_testnet -- [nodes]`

use std::io::{Read, Write};

fn main() {
    let nodes = std::env::args()
        .nth(1)
        .and_then(|n| n.parse().ok())
        .unwrap_or(8);
    let testnet = mainline::Testnet::builder(nodes)
        .build()
        .expect("a DHT testnet on 127.0.0.1");
    println!("{}", testnet.bootstrap.join(","));
    std::io::stdout().flush().ok();
    let _ = std::io::stdin().read_to_end(&mut Vec::new());
    drop(testnet);
}
