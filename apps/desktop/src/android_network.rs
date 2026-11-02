//! What the Kotlin side's reports have the app look at again (`android.rs` hears them). Apart from `android.rs` so its
//! tests run on any host.

/// What a report has looked at again: the Pkarr client's relays (every breaker and rest forgotten), and every Iroh
/// endpoint's network (`Endpoint::network_change`).
#[derive(Debug, PartialEq, Eq)]
pub struct Recheck {
    pub pkarr: bool,
    pub iroh: bool,
}

/// A new network ("network"): both, since Android denies Iroh's netwatch the routing table and it may not see one
/// itself. The activity back in front ("visibility", "visible"): the Pkarr client's relays only. While the app was away,
/// Doze cut its network with no network change to say so, its relay requests timed out, and the relays it left alone
/// held the chats' first reads after the return for about 4 s. Iroh is not told: asked to look again then, it held a
/// chat with a CLI bot longer (13.4 s against 4.4 s, the emulator, 2026-11-01); a chat knocks again once its endpoint
/// is back on its relay instead (ghostlink.ts `knockAgain`).
pub fn recheck(kind: &str, value: &str) -> Recheck {
    Recheck {
        pkarr: kind == "network" || (kind == "visibility" && value == "visible"),
        iroh: kind == "network",
    }
}

#[cfg(test)]
mod tests {
    // covers: core.relay-breaker, chat.paired.reconnect
    use super::*;

    const NOTHING: Recheck = Recheck {
        pkarr: false,
        iroh: false,
    };

    #[test]
    fn a_network_change_has_the_relays_and_every_endpoint_look_again() {
        for what in ["available", "lost", "addresses"] {
            assert_eq!(
                recheck("network", what),
                Recheck {
                    pkarr: true,
                    iroh: true
                },
                "{what}"
            );
        }
    }

    /// Miguel's phone in a pocket, as the emulator's Doze has it (2026-11-01): five minutes away, the app's relay
    /// requests timed out and the Pkarr client left its relay alone. Back in front, the first read of a chat with a CLI
    /// bot waited about 4 s for that relay's rest, and "Publication unavailable" showed meanwhile.
    #[test]
    fn the_app_back_in_front_has_the_relays_asked_again_and_leaves_iroh_be() {
        assert_eq!(
            recheck("visibility", "visible"),
            Recheck {
                pkarr: true,
                iroh: false
            }
        );
    }

    #[test]
    fn the_app_going_away_or_anything_else_has_nothing_looked_at() {
        assert_eq!(recheck("visibility", "hidden"), NOTHING);
        for kind in ["oidc", "notification", "share"] {
            assert_eq!(recheck(kind, "visible"), NOTHING, "{kind}");
        }
    }
}
