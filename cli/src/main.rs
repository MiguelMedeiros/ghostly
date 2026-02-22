use clap::{Parser, Subcommand};
use ghostly::{generate_invite, new_identity, parse_invite, ErrorOutput, GhostClient, WatchEvent};
use std::io::{self, Write};

#[derive(Parser)]
#[command(name = "ghostly-cli")]
#[command(author = "Ghost Protocol")]
#[command(version = "0.1.0")]
#[command(about = "CLI for Ghost protocol - encrypted ephemeral messaging for bots", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Commands,

    /// Output format (always JSON)
    #[arg(long, default_value = "true", global = true)]
    json: bool,

    /// Suppress extra output
    #[arg(long, short, global = true)]
    quiet: bool,
}

#[derive(Subcommand)]
enum Commands {
    /// Create a new identity (keypair + shared key)
    Identity {
        #[command(subcommand)]
        action: IdentityAction,
    },
    /// Generate or parse invite codes
    Invite {
        #[command(subcommand)]
        action: InviteAction,
    },
    /// Send a message
    Send {
        /// Your seed (base64url)
        #[arg(long)]
        seed: String,

        /// Peer's public key (z32)
        #[arg(long)]
        peer: String,

        /// Shared encryption key (base64url)
        #[arg(long)]
        key: String,

        /// Your nickname (optional)
        #[arg(long)]
        nick: Option<String>,

        /// Read message from stdin instead of argument
        #[arg(long)]
        stdin: bool,

        /// Message text (if not using --stdin)
        message: Option<String>,
    },
    /// Receive messages (single poll)
    Recv {
        /// Peer's public key (z32)
        #[arg(long)]
        peer: String,

        /// Shared encryption key (base64url)
        #[arg(long)]
        key: String,
    },
    /// Watch for new messages (streaming mode for bots)
    Watch {
        /// Your seed (base64url)
        #[arg(long)]
        seed: String,

        /// Peer's public key (z32)
        #[arg(long)]
        peer: String,

        /// Shared encryption key (base64url)
        #[arg(long)]
        key: String,

        /// Your nickname (optional)
        #[arg(long)]
        nick: Option<String>,

        /// Poll interval in milliseconds
        #[arg(long, default_value = "2000")]
        poll_interval: u64,

        /// ACK received messages automatically
        #[arg(long, default_value = "true")]
        ack: bool,
    },
}

#[derive(Subcommand)]
enum IdentityAction {
    /// Create a new identity
    New,
}

#[derive(Subcommand)]
enum InviteAction {
    /// Generate an invite URL
    New {
        /// Your seed (base64url)
        #[arg(long)]
        seed: String,

        /// Shared key (optional, generates new if not provided)
        #[arg(long)]
        key: Option<String>,
    },
    /// Parse an invite URL
    Parse {
        /// The invite URL (ghost://...)
        url: String,
    },
}

fn output_json<T: serde::Serialize>(value: &T) {
    println!("{}", serde_json::to_string(value).unwrap());
}

fn output_error(msg: &str) {
    let err = ErrorOutput {
        error: msg.to_string(),
    };
    eprintln!("{}", serde_json::to_string(&err).unwrap());
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    match cli.command {
        Commands::Identity { action } => match action {
            IdentityAction::New => {
                let identity = new_identity();
                output_json(&identity);
            }
        },

        Commands::Invite { action } => match action {
            InviteAction::New { seed, key } => {
                let shared_key =
                    key.unwrap_or_else(|| ghostly::to_base64_url(&ghostly::generate_key()));
                match generate_invite(&seed, &shared_key) {
                    Ok(invite) => output_json(&invite),
                    Err(e) => {
                        output_error(&e);
                        std::process::exit(1);
                    }
                }
            }
            InviteAction::Parse { url } => match parse_invite(&url) {
                Ok(parsed) => output_json(&parsed),
                Err(e) => {
                    output_error(&e);
                    std::process::exit(1);
                }
            },
        },

        Commands::Send {
            seed,
            peer,
            key,
            nick,
            stdin,
            message,
        } => {
            let msg = if stdin {
                let mut input = String::new();
                io::stdin()
                    .read_line(&mut input)
                    .expect("Failed to read from stdin");
                input.trim().to_string()
            } else {
                match message {
                    Some(m) => m,
                    None => {
                        output_error("Message required (provide as argument or use --stdin)");
                        std::process::exit(1);
                    }
                }
            };

            if msg.is_empty() {
                output_error("Message cannot be empty");
                std::process::exit(1);
            }

            let client = GhostClient::new();
            match client.send(&seed, &peer, &key, &msg, nick.as_deref()).await {
                Ok(result) => output_json(&result),
                Err(e) => {
                    output_error(&e);
                    std::process::exit(1);
                }
            }
        }

        Commands::Recv { peer, key } => {
            let client = GhostClient::new();
            match client.recv(&peer, &key).await {
                Ok(result) => output_json(&result),
                Err(e) => {
                    output_error(&e);
                    std::process::exit(1);
                }
            }
        }

        Commands::Watch {
            seed,
            peer,
            key,
            nick,
            poll_interval,
            ack,
        } => {
            let client = GhostClient::new();
            let mut last_seen_ts: i64 = 0;
            let key_bytes = match ghostly::from_base64_url(&key) {
                Ok(k) => k,
                Err(e) => {
                    output_error(&e);
                    std::process::exit(1);
                }
            };
            let keypair = match ghostly::keypair_from_seed(&seed) {
                Ok(k) => k,
                Err(e) => {
                    output_error(&e);
                    std::process::exit(1);
                }
            };

            loop {
                match client.recv(&peer, &key).await {
                    Ok(batch) => {
                        let new_messages: Vec<_> = batch
                            .messages
                            .into_iter()
                            .filter(|m| m.timestamp > last_seen_ts)
                            .collect();

                        for msg in &new_messages {
                            let event = WatchEvent {
                                from: "peer".to_string(),
                                text: msg.text.clone(),
                                timestamp: msg.timestamp,
                                nick: msg.nick.clone(),
                            };
                            output_json(&event);
                            io::stdout().flush().ok();

                            if msg.timestamp > last_seen_ts {
                                last_seen_ts = msg.timestamp;
                            }
                        }

                        if ack && !new_messages.is_empty() {
                            let pkarr_client = pkarr::Client::builder()
                                .build()
                                .expect("Failed to create client");
                            let _ = ghostly::publish_messages(
                                &pkarr_client,
                                &keypair,
                                &[],
                                &key_bytes,
                                last_seen_ts,
                                nick.as_deref(),
                            )
                            .await;
                        }
                    }
                    Err(e) => {
                        if !cli.quiet {
                            output_error(&e);
                        }
                    }
                }

                tokio::time::sleep(tokio::time::Duration::from_millis(poll_interval)).await;
            }
        }
    }
}
