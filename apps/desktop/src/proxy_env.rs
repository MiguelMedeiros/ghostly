//! A proxy set in the environment is never handed a request for this machine, on Linux.
//!
//! WebKitGTK takes its proxy from the environment the app started in (`http_proxy` and the like) and leaves out only
//! the hosts `no_proxy` names. The page plays a stored file from a server on 127.0.0.1 (file_stream.rs), at a URL
//! that carries the file's token: with a proxy set and 127.0.0.1 not in `no_proxy`, that request went to the proxy,
//! token and all, and the file never played. So 127.0.0.1 is added to `no_proxy` and `NO_PROXY` before the WebView
//! (and its network process, which inherits the environment) exists. What the variables already hold stays.

/// The address the stored files are served on (file_stream.rs, `stream_url`).
const LOOPBACK: &str = "127.0.0.1";

/// The two spellings programs read; some read only one, some prefer one over the other.
const NAMES: [&str; 2] = ["no_proxy", "NO_PROXY"];

/// `current` with 127.0.0.1 added, or nothing when it already leaves it out of the proxy (by name, or `*` for every
/// host).
fn with_loopback(current: Option<&str>) -> Option<String> {
    let hosts: Vec<&str> = current
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .collect();
    if hosts.iter().any(|host| *host == LOOPBACK || *host == "*") {
        return None;
    }
    Some(
        hosts
            .into_iter()
            .chain([LOOPBACK])
            .collect::<Vec<_>>()
            .join(","),
    )
}

/// What to set, given what `no_proxy` and `NO_PROXY` hold. A spelling that is not set starts from the other one's
/// hosts: set to 127.0.0.1 alone, it would hide them from a program that reads it first.
fn changes(read: &dyn Fn(&str) -> Option<String>) -> Vec<(&'static str, String)> {
    let held = NAMES.map(|name| read(name).filter(|value| !value.trim().is_empty()));
    NAMES
        .iter()
        .enumerate()
        .filter_map(|(index, name)| {
            let current = held[index].as_deref().or(held[1 - index].as_deref());
            Some((*name, with_loopback(current)?))
        })
        .collect()
}

/// Called first in `run`, while this is the only thread: the environment is not safe to change once others read it.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn exempt_loopback() {
    for (name, value) in changes(&|name| std::env::var(name).ok()) {
        std::env::set_var(name, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn after(lower: Option<&str>, upper: Option<&str>) -> Vec<(&'static str, String)> {
        changes(&|name| {
            match name {
                "no_proxy" => lower,
                _ => upper,
            }
            .map(str::to_string)
        })
    }

    fn both(value: &str) -> Vec<(&'static str, String)> {
        vec![
            ("no_proxy", value.to_string()),
            ("NO_PROXY", value.to_string()),
        ]
    }

    #[test]
    fn loopback_is_added_when_nothing_is_set() {
        assert_eq!(after(None, None), both("127.0.0.1"));
        assert_eq!(after(Some(""), Some(" ")), both("127.0.0.1"));
    }

    #[test]
    fn what_is_there_stays() {
        assert_eq!(
            after(Some("localhost"), Some("localhost")),
            both("localhost,127.0.0.1")
        );
        assert_eq!(
            after(Some("localhost, .corp.example ,"), Some("10.0.0.0/8")),
            vec![
                ("no_proxy", "localhost,.corp.example,127.0.0.1".to_string()),
                ("NO_PROXY", "10.0.0.0/8,127.0.0.1".to_string()),
            ]
        );
    }

    #[test]
    fn a_spelling_that_is_not_set_takes_the_others_hosts() {
        assert_eq!(after(Some("localhost"), None), both("localhost,127.0.0.1"));
        assert_eq!(
            after(None, Some(".corp.example")),
            both(".corp.example,127.0.0.1")
        );
    }

    #[test]
    fn nothing_changes_when_loopback_is_already_left_out() {
        assert_eq!(
            after(Some("localhost,127.0.0.1"), Some("127.0.0.1")),
            vec![]
        );
        assert_eq!(after(Some("*"), Some("*")), vec![]);
        assert_eq!(after(Some(" 127.0.0.1 "), None), vec![]);
        // 127.0.0.10 is another host.
        assert_eq!(
            after(Some("127.0.0.10"), Some("127.0.0.10")),
            both("127.0.0.10,127.0.0.1")
        );
    }

    /// The app's own environment after `exempt_loopback`, as its WebView's processes inherit it: a child run of this
    /// test binary (`the_environment_leaves_loopback_out`) started with a proxy and `no_proxy=localhost`, since the
    /// environment belongs to the whole process and the other tests share it.
    #[test]
    fn the_app_starts_with_loopback_out_of_the_proxy() {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap());
        child.args([
            "--ignored",
            "--exact",
            "proxy_env::tests::the_environment_leaves_loopback_out",
            "--test-threads=1",
        ]);
        child
            .env("http_proxy", "http://127.0.0.1:9")
            .env("no_proxy", "localhost")
            .env_remove("NO_PROXY");
        let output = child.output().unwrap();
        let log = String::from_utf8_lossy(&output.stdout);
        assert!(
            log.contains("1 passed"),
            "the child run did not pass:\n{log}"
        );
    }

    #[test]
    #[ignore = "run by the_app_starts_with_loopback_out_of_the_proxy, with a proxy set"]
    fn the_environment_leaves_loopback_out() {
        exempt_loopback();
        for name in NAMES {
            assert_eq!(std::env::var(name).unwrap(), "localhost,127.0.0.1");
        }
        assert_eq!(std::env::var("http_proxy").unwrap(), "http://127.0.0.1:9");
    }
}
