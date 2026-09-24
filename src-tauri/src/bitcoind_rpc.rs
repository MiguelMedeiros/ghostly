//! The wallet RPC of the user's own Bitcoin Core node, for the on-chain source
//! of the same name (`packages/browser/.../providers/bitcoind.ts`).
//!
//! bitcoind answers no CORS preflight, so the WebView cannot call it; Rust can.
//! This is not a general proxy: only the methods the source needs are
//! forwarded (nothing that exports a key, changes a passphrase or sends on its
//! own), to the URL the user configured, without following redirects, with
//! bounded bodies and time-outs. Credentials go in the Authorization header and
//! never into a URL or an error.

use std::sync::OnceLock;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};

/// Every method the source calls. Wallet methods go to `/wallet/<name>`.
const WALLET_METHODS: &[&str] = &[
    "getwalletinfo",
    "getnewaddress",
    "getbalances",
    "listtransactions",
    "gettransaction",
    "walletcreatefundedpsbt",
    "walletprocesspsbt",
    "lockunspent",
];
const NODE_METHODS: &[&str] = &[
    "getblockchaininfo",
    "estimatesmartfee",
    "finalizepsbt",
    "sendrawtransaction",
    "getmempoolentry",
];

const MAX_REQUEST_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_MESSAGE: usize = 300;

/// Why a call failed. `kind` tells the source what it may conclude:
/// - `refused`: never sent (not allowed, bad URL or wallet name, too big).
/// - `connect`: no connection could be made, so the node never saw the call.
/// - `auth`: the node refused the credentials.
/// - `rpc`: the node answered with a JSON-RPC error `code`.
/// - `transport`: anything else (a time-out, a cut connection, a body that is
///   not JSON-RPC). The call may or may not have run.
#[derive(Debug, Serialize, PartialEq)]
pub struct RpcError {
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<i64>,
    pub message: String,
}

impl RpcError {
    fn new(kind: &'static str, message: impl Into<String>) -> Self {
        let mut message: String = message.into();
        if message.len() > MAX_MESSAGE {
            let mut end = MAX_MESSAGE;
            while !message.is_char_boundary(end) {
                end -= 1;
            }
            message.truncate(end);
        }
        RpcError {
            kind,
            code: None,
            message,
        }
    }
}

fn is_wallet_name_safe(name: &str) -> bool {
    name.len() <= 64
        && name != "."
        && name != ".."
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// Where a call goes, checked before anything is sent.
pub fn endpoint(url: &str, wallet: &str, method: &str) -> Result<reqwest::Url, RpcError> {
    let wallet_method = WALLET_METHODS.contains(&method);
    if !wallet_method && !NODE_METHODS.contains(&method) {
        return Err(RpcError::new(
            "refused",
            format!("{} is not a method Ghostly uses", method),
        ));
    }
    let mut url =
        reqwest::Url::parse(url).map_err(|_| RpcError::new("refused", "Invalid node URL"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host().is_none() {
        return Err(RpcError::new(
            "refused",
            "The node URL must be http(s)://host:port",
        ));
    }
    // Credentials belong in their own fields, where they are sealed; one in the
    // URL would be stored in the clear and could end up in an error.
    if !url.username().is_empty() || url.password().is_some() {
        return Err(RpcError::new(
            "refused",
            "Put the RPC user and password in their own fields, not in the URL",
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(RpcError::new(
            "refused",
            "The node URL cannot have a query or fragment",
        ));
    }
    if !is_wallet_name_safe(wallet) {
        return Err(RpcError::new(
            "refused",
            "A wallet name has only letters, digits, '-', '_' and '.'",
        ));
    }
    if wallet_method && !wallet.is_empty() {
        url.path_segments_mut()
            .map_err(|_| RpcError::new("refused", "Invalid node URL"))?
            .pop_if_empty()
            .extend(["wallet", wallet]);
    }
    Ok(url)
}

fn client() -> Result<&'static reqwest::Client, RpcError> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| RpcError::new("refused", format!("HTTP client: {}", e)))?;
    Ok(CLIENT.get_or_init(|| client))
}

/// What the node's answer means: the `result`, or why there is none.
pub fn interpret(status: u16, body: &[u8]) -> Result<Value, RpcError> {
    if status == 401 || status == 403 {
        return Err(RpcError::new(
            "auth",
            "The node refused the RPC user and password",
        ));
    }
    let Ok(Value::Object(reply)) = serde_json::from_slice::<Value>(body) else {
        return Err(RpcError::new(
            "transport",
            format!("The node answered HTTP {} without a JSON-RPC reply", status),
        ));
    };
    match reply.get("error") {
        Some(Value::Null) | None => {}
        Some(error) => {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("RPC error");
            let mut failure = RpcError::new("rpc", message);
            failure.code = error.get("code").and_then(Value::as_i64);
            return Err(failure);
        }
    }
    if status != 200 {
        return Err(RpcError::new(
            "transport",
            format!("The node answered HTTP {}", status),
        ));
    }
    Ok(reply.get("result").cloned().unwrap_or(Value::Null))
}

fn classify(error: reqwest::Error) -> RpcError {
    // Only a failure to connect proves the node never received the call.
    let kind = if error.is_connect() {
        "connect"
    } else {
        "transport"
    };
    let what = if error.is_timeout() {
        "timed out"
    } else if error.is_connect() {
        "unreachable"
    } else {
        "connection failed"
    };
    RpcError::new(kind, format!("The node is {}", what))
}

pub async fn call(
    url: String,
    wallet: String,
    user: String,
    password: String,
    method: String,
    params: Vec<Value>,
) -> Result<Value, RpcError> {
    let target = endpoint(&url, &wallet, &method)?;
    let body = serde_json::to_vec(&json!({
        "jsonrpc": "1.0",
        "id": "ghostly",
        "method": method,
        "params": params,
    }))
    .map_err(|_| RpcError::new("refused", "Invalid parameters"))?;
    if body.len() > MAX_REQUEST_BYTES {
        return Err(RpcError::new("refused", "Request too large"));
    }
    let auth = format!(
        "Basic {}",
        STANDARD.encode(format!("{}:{}", user, password))
    );

    let mut response = client()?
        .post(target)
        .header(reqwest::header::AUTHORIZATION, auth)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(classify)?;
    let status = response.status().as_u16();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(RpcError::new("transport", "Response too large"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(classify)? {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(RpcError::new("transport", "Response too large"));
        }
        bytes.extend_from_slice(&chunk);
    }
    interpret(status, &bytes)
}

#[cfg(test)]
mod tests {
    // covers: wallet.onchain.bitcoind
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn refused(result: Result<reqwest::Url, RpcError>) -> String {
        let error = result.expect_err("should be refused");
        assert_eq!(error.kind, "refused");
        error.message
    }

    #[test]
    fn forwards_only_the_allowed_methods() {
        for method in [
            "dumpprivkey",
            "listdescriptors",
            "sendtoaddress",
            "sendmany",
            "send",
            "walletpassphrase",
            "encryptwallet",
            "importdescriptors",
            "stop",
            "createwallet",
            "unloadwallet",
            "GETBALANCES",
            "",
        ] {
            refused(endpoint("http://127.0.0.1:18443", "w", method));
        }
        for method in WALLET_METHODS.iter().chain(NODE_METHODS) {
            assert!(endpoint("http://127.0.0.1:18443", "w", method).is_ok());
        }
    }

    #[test]
    fn sends_wallet_methods_to_the_wallet_and_node_methods_to_the_node() {
        let url = |wallet: &str, method: &str| {
            endpoint("http://127.0.0.1:18443/", wallet, method)
                .unwrap()
                .to_string()
        };
        assert_eq!(
            url("alice", "getbalances"),
            "http://127.0.0.1:18443/wallet/alice"
        );
        assert_eq!(url("alice", "getblockchaininfo"), "http://127.0.0.1:18443/");
        assert_eq!(
            url("alice", "sendrawtransaction"),
            "http://127.0.0.1:18443/"
        );
        assert_eq!(url("", "getbalances"), "http://127.0.0.1:18443/");
        assert_eq!(
            endpoint("https://node.example/rpc", "a.b-c_1", "getnewaddress")
                .unwrap()
                .to_string(),
            "https://node.example/rpc/wallet/a.b-c_1"
        );
    }

    #[test]
    fn refuses_urls_and_wallet_names_that_could_go_elsewhere() {
        for url in [
            "file:///etc/passwd",
            "ftp://127.0.0.1",
            "http://user:secret@127.0.0.1:18443",
            "http://127.0.0.1:18443/?wallet=x",
            "http://127.0.0.1:18443/#x",
            "not a url",
        ] {
            let message = refused(endpoint(url, "w", "getbalances"));
            assert!(!message.contains("secret"));
        }
        for wallet in ["..", "../other", "a/b", "a%2Fb", "w?x", &"w".repeat(65)] {
            refused(endpoint("http://127.0.0.1:18443", wallet, "getbalances"));
        }
    }

    #[test]
    fn reads_results_errors_and_refusals() {
        assert_eq!(
            interpret(
                200,
                br#"{"result":{"chain":"regtest"},"error":null,"id":"ghostly"}"#
            ),
            Ok(json!({"chain": "regtest"}))
        );
        // bitcoind answers RPC errors with HTTP 500 (or 404 for an unknown method).
        let error = interpret(
            500,
            br#"{"result":null,"error":{"code":-26,"message":"min relay fee not met"},"id":"ghostly"}"#,
        )
        .unwrap_err();
        assert_eq!((error.kind, error.code), ("rpc", Some(-26)));
        assert_eq!(interpret(401, b"").unwrap_err().kind, "auth");
        assert_eq!(interpret(502, b"<html>").unwrap_err().kind, "transport");
        assert_eq!(interpret(200, b"[1]").unwrap_err().kind, "transport");
        let long = format!(
            r#"{{"result":null,"error":{{"code":-1,"message":"{}"}}}}"#,
            "é".repeat(400)
        );
        assert!(interpret(500, long.as_bytes()).unwrap_err().message.len() <= MAX_MESSAGE);
    }

    /// A one-shot HTTP server on a free port, answering `reply` to whatever comes.
    fn serve(reply: Vec<u8>) -> (String, std::thread::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = vec![0u8; 64 * 1024];
            let n = stream.read(&mut request).unwrap();
            request.truncate(n);
            let _ = stream.write_all(&reply);
            request
        });
        (url, handle)
    }

    #[tokio::test]
    async fn authenticates_in_a_header_and_never_follows_a_redirect() {
        let body = br#"{"result":"bcrt1qxyz","error":null,"id":"ghostly"}"#;
        let mut reply = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
        .into_bytes();
        reply.extend_from_slice(body);
        let (url, server) = serve(reply);
        let result = call(
            url,
            "w".into(),
            "u".into(),
            "p".into(),
            "getnewaddress".into(),
            vec![],
        )
        .await
        .unwrap();
        assert_eq!(result, json!("bcrt1qxyz"));
        let request = String::from_utf8(server.join().unwrap()).unwrap();
        assert!(request.starts_with("POST /wallet/w HTTP/1.1"));
        assert!(request.to_ascii_lowercase().contains(
            &format!("authorization: basic {}", STANDARD.encode("u:p")).to_ascii_lowercase()
        ));

        let (url, server) = serve(
            b"HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:1/\r\nContent-Length: 0\r\n\r\n".to_vec(),
        );
        let error = call(
            url,
            "w".into(),
            "u".into(),
            "p".into(),
            "getbalances".into(),
            vec![],
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind, "transport");
        server.join().unwrap();
    }

    #[tokio::test]
    async fn refuses_an_oversized_answer() {
        let (url, server) = serve(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                MAX_RESPONSE_BYTES + 1
            )
            .into_bytes(),
        );
        let error = call(
            url,
            "".into(),
            "u".into(),
            "p".into(),
            "getblockchaininfo".into(),
            vec![],
        )
        .await
        .unwrap_err();
        assert_eq!(
            (error.kind, error.message.as_str()),
            ("transport", "Response too large")
        );
        server.join().unwrap();
    }

    #[tokio::test]
    async fn an_unreachable_node_is_a_connect_error_and_an_oversized_request_is_never_sent() {
        // Bind then drop: nothing listens on this port any more.
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let error = call(
            format!("http://127.0.0.1:{}", port),
            "".into(),
            "u".into(),
            "p".into(),
            "sendrawtransaction".into(),
            vec![json!("00")],
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind, "connect");

        let error = call(
            format!("http://127.0.0.1:{}", port),
            "".into(),
            "u".into(),
            "p".into(),
            "sendrawtransaction".into(),
            vec![json!("0".repeat(MAX_REQUEST_BYTES))],
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind, "refused");
    }
}

/// The proxy against a node played by a test server.
#[cfg(test)]
mod proxy_tests {
    use super::*;
    use crate::test_support::{closed_port, read_request, tokio_listener, Requests};
    use tokio::io::AsyncWriteExt;

    /// A node answering one request with `reply`; returns its URL and the request it saw.
    fn node(reply: Vec<u8>) -> (String, Requests) {
        let listener = tokio_listener();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Requests::default();
        let log = seen.clone();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            if let Some(request) = read_request(&mut stream).await {
                log.lock().unwrap().push(request);
            }
            let _ = stream.write_all(&reply).await;
            let _ = stream.shutdown().await;
        });
        (url, seen)
    }

    fn ok(body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    async fn rpc(url: String, method: &str, params: Vec<Value>) -> Result<Value, RpcError> {
        call(
            url,
            "w".into(),
            "alice".into(),
            "hunter2-secret".into(),
            method.into(),
            params,
        )
        .await
    }

    #[tokio::test]
    async fn sends_one_json_rpc_call_with_its_params_to_the_wallet() {
        let (url, seen) = node(ok(
            r#"{"result":{"psbt":"cHNidP8"},"error":null,"id":"ghostly"}"#,
        ));
        let params = vec![
            json!([]),
            json!([{"bcrt1qxyz": 0.1}]),
            json!(0),
            json!({"fee_rate": 2}),
        ];
        let result = rpc(url, "walletcreatefundedpsbt", params.clone())
            .await
            .unwrap();
        assert_eq!(result, json!({"psbt": "cHNidP8"}));

        let (head, body) = seen.lock().unwrap()[0].clone();
        let first = head.lines().next().unwrap();
        assert_eq!(first, "POST /wallet/w HTTP/1.1");
        assert!(head
            .to_ascii_lowercase()
            .contains("content-type: application/json"));
        let sent: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            sent,
            json!({"jsonrpc": "1.0", "id": "ghostly", "method": "walletcreatefundedpsbt", "params": params})
        );
    }

    #[tokio::test]
    async fn no_error_carries_the_credentials() {
        let port = closed_port();
        let refused = rpc(format!("http://127.0.0.1:{port}"), "getbalances", vec![])
            .await
            .unwrap_err();
        let (url, _) = node(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n".to_vec());
        let auth = rpc(url, "getbalances", vec![]).await.unwrap_err();
        assert_eq!(auth.kind, "auth");
        for error in [refused, auth] {
            let text = serde_json::to_string(&error).unwrap();
            assert!(
                !text.contains("hunter2") && !text.contains("alice"),
                "{text}"
            );
            assert!(!text.contains(&port.to_string()), "{text}");
        }
    }

    #[tokio::test]
    async fn an_answer_that_breaks_off_or_grows_past_the_limit_is_a_transport_error() {
        let (url, _) = node(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{\"result\":".to_vec());
        assert_eq!(
            rpc(url, "getbalances", vec![]).await.unwrap_err().kind,
            "transport"
        );

        // No Content-Length to refuse up front: the limit holds while reading.
        let listener = tokio_listener();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_request(&mut stream).await;
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
                .await;
            let chunk = vec![b' '; 64 * 1024];
            for _ in 0..=MAX_RESPONSE_BYTES / chunk.len() {
                let head = format!("{:x}\r\n", chunk.len());
                if stream.write_all(head.as_bytes()).await.is_err()
                    || stream.write_all(&chunk).await.is_err()
                    || stream.write_all(b"\r\n").await.is_err()
                {
                    return;
                }
            }
        });
        let error = rpc(url, "listtransactions", vec![]).await.unwrap_err();
        assert_eq!(
            (error.kind, error.message.as_str()),
            ("transport", "Response too large")
        );
    }

    #[test]
    fn reads_every_shape_of_answer() {
        assert_eq!(interpret(403, b"").unwrap_err().kind, "auth");
        // An unknown method: HTTP 404 with a JSON-RPC error.
        let error = interpret(
            404,
            br#"{"result":null,"error":{"code":-32601,"message":"Method not found"},"id":"ghostly"}"#,
        )
        .unwrap_err();
        assert_eq!((error.kind, error.code), ("rpc", Some(-32601)));
        assert_eq!(
            interpret(200, br#"{"result":null,"error":null}"#),
            Ok(Value::Null)
        );
        assert_eq!(interpret(200, br#"{"error":null}"#), Ok(Value::Null));
        let error = interpret(500, br#"{"error":{"code":"x"}}"#).unwrap_err();
        assert_eq!(
            (error.kind, error.code, error.message.as_str()),
            ("rpc", None, "RPC error")
        );
        // A 200 that is still an error is an error.
        assert_eq!(
            interpret(
                200,
                br#"{"error":{"code":-4,"message":"Insufficient funds"}}"#
            )
            .unwrap_err()
            .code,
            Some(-4)
        );
        assert_eq!(
            interpret(503, br#"{"result":1}"#).unwrap_err().kind,
            "transport"
        );
        assert_eq!(interpret(200, b"").unwrap_err().kind, "transport");
    }

    #[test]
    fn keeps_the_node_path_and_takes_ipv6_hosts() {
        assert_eq!(
            endpoint("http://[::1]:18443", "w", "getbalances")
                .unwrap()
                .to_string(),
            "http://[::1]:18443/wallet/w"
        );
        assert_eq!(
            endpoint("https://node.example/rpc/", "w", "getbalances")
                .unwrap()
                .to_string(),
            "https://node.example/rpc/wallet/w"
        );
        assert!(endpoint("http://", "w", "getbalances").is_err());
        assert!(endpoint("http://127.0.0.1", ".", "getbalances").is_err());
        assert!(endpoint("http://127.0.0.1", &"w".repeat(64), "getbalances").is_ok());
    }
}
