/// Names only a local network answers (RFC 6762, RFC 8375, ICANN's .internal, and the usual router and company
/// ones). The same list as packages/core/src/localNames.ts and apps/ui/src/lib/localHost.ts
/// (apps/ui/src/test/chat/linkPreviewParse.test.ts pins all three).
pub(crate) const LOCAL_SUFFIXES: &[&str] = &[
    "localhost",
    "local",
    "internal",
    "lan",
    "home",
    "home.arpa",
    "localdomain",
    "intranet",
    "corp",
];

/// Whether a lowercase name with no trailing dot is one of `LOCAL_SUFFIXES` or under one.
pub(crate) fn under_local_suffix(name: &str) -> bool {
    LOCAL_SUFFIXES.iter().any(|suffix| {
        name == *suffix
            || name
                .strip_suffix(suffix)
                .is_some_and(|rest| rest.ends_with('.'))
    })
}
