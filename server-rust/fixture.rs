//! Native disposable servers for browser/import clients and the storage lab.
//! Compiled only with `test-support`; never linked into the deployed service.
use crate::{
    error::{Error, Result},
    identity,
    server::{self, Config},
    storage::mkdir_durable,
};
use axum::serve::ListenerExt;
use axum::{
    Router,
    body::Body,
    extract::Request,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use std::{
    io::{BufRead, Write},
    net::SocketAddr,
};
use tokio::net::{TcpListener, TcpStream};

// Upgrade traffic alternates short receipts with binary chunks. Preserve Node's
// TCP_NODELAY behavior on the browser-facing leg as well as the upstream leg.
pub(crate) fn gateway_listener(
    listener: TcpListener,
) -> impl axum::serve::Listener<Io = TcpStream, Addr = SocketAddr> {
    listener.tap_io(|stream| {
        if let Err(error) = stream.set_nodelay(true) {
            eprintln!("Could not enable TCP_NODELAY for the fixture proxy: {error}");
        }
    })
}

pub(crate) async fn forward(mut request: Request, target: SocketAddr) -> Result<Response> {
    let downstream = hyper::upgrade::on(&mut request);
    let stream = TcpStream::connect(target).await?;
    stream.set_nodelay(true)?;
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|e| Error::invalid(e.to_string()))?;
    tokio::spawn(async move {
        let _ = connection.with_upgrades().await;
    });
    let mut response = sender
        .send_request(request)
        .await
        .map_err(|e| Error::invalid(e.to_string()))?;
    if response.status() == StatusCode::SWITCHING_PROTOCOLS {
        let upstream = hyper::upgrade::on(&mut response);
        tokio::spawn(async move {
            if let (Ok(a), Ok(b)) = tokio::join!(downstream, upstream) {
                let _ =
                    tokio::io::copy_bidirectional(&mut TokioIo::new(a), &mut TokioIo::new(b)).await;
            }
        });
    }
    Ok(response.map(Body::new))
}
pub(crate) fn cookie(request: &Request, name: &str) -> Option<String> {
    let cookies = identity::single_header(request.headers(), "cookie")?;
    let value = cookies
        .split(';')
        .map(str::trim)
        .find_map(|part| part.strip_prefix(&format!("{name}=")))?;
    percent_encoding::percent_decode_str(value)
        .decode_utf8()
        .ok()
        .map(|v| v.into_owned())
}
pub(crate) async fn shutdown() {
    let mut signal = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("signal handler");
    tokio::select! {_=tokio::signal::ctrl_c()=>{},_=signal.recv()=>{}}
}
async fn browser() -> Result<()> {
    let data = tempfile::tempdir()?;
    let users_dir = tempfile::tempdir()?;
    let single=server::start(Config::for_test(&json!({"port":4173,"host":"127.0.0.1","dataDir":data.path(),"password":"","authMode":"password"}))?).await?;
    let secret = [7; 32];
    std::fs::write(users_dir.path().join("session-secret"), secret)?;
    std::fs::write(
        users_dir.path().join("vault.yjs"),
        include_bytes!("tests/fixtures/browser-obsolete.yjs"),
    )?;
    let owner = users_dir
        .path()
        .join("users")
        .join(identity::vault_identity(
            &secret,
            identity::AuthMode::Proxy,
            "owner@example.test",
        ));
    mkdir_durable(&owner)?;
    std::fs::write(
        owner.join("vault.yjs"),
        include_bytes!("tests/fixtures/browser-owner.yjs"),
    )?;
    const PROOF: &str = "stow-browser-test-proxy-secret-32-characters";
    let users=server::start(Config::for_test(&json!({"port":0,"host":"127.0.0.1","origin":"http://localhost:4174","dataDir":users_dir.path(),"authMode":"proxy","proxySecret":PROOF}))?).await?;
    let target = users.address;
    let router = Router::new().fallback(move |mut req: Request| async move {
        let user = cookie(&req, "stow_test_user");
        req.headers_mut().remove("x-auth-user");
        req.headers_mut()
            .insert("x-stow-proxy-secret", PROOF.parse().unwrap());
        if let Some(user) = user {
            let Ok(value) = user.parse() else {
                return StatusCode::BAD_REQUEST.into_response();
            };
            req.headers_mut().insert("x-auth-user", value);
        }
        forward(req, target)
            .await
            .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
    });
    let listener = TcpListener::bind(("127.0.0.1", 4174)).await?;
    let gateway = tokio::spawn(async move {
        axum::serve(gateway_listener(listener), router)
            .with_graceful_shutdown(shutdown())
            .await
    });
    shutdown().await;
    single.close().await?;
    users.close().await?;
    gateway.await.map_err(|e| Error::invalid(e.to_string()))??;
    Ok(())
}
fn output(v: Value) -> Result<()> {
    let mut out = std::io::stdout().lock();
    serde_json::to_writer(&mut out, &v)?;
    writeln!(out)?;
    out.flush()?;
    Ok(())
}
pub async fn run() -> Result<()> {
    match std::env::args().nth(1).as_deref() {
        Some("browser") => return browser().await,
        Some("lab") => return crate::lab::run().await,
        Some("serve") => {}
        _ => return Err(Error::invalid("Use serve, browser or lab")),
    }
    let stdin = std::io::stdin();
    let mut input = stdin.lock().lines();
    let options: Value = serde_json::from_str(
        &input
            .next()
            .transpose()?
            .ok_or_else(|| Error::invalid("Missing configuration"))?,
    )?;
    if let Some(directory) = options["storageGate"].as_str() {
        crate::storage::TEST_STORAGE_GATE
            .set(directory.into())
            .map_err(|_| Error::invalid("Storage gate already configured"))?;
    }
    let running = server::start(Config::for_test(&options)?).await?;
    output(json!({"port":running.address.port(),"address":running.address.ip().to_string()}))?;
    for line in input {
        let v: Value = serde_json::from_str(&line?)?;
        match v["op"].as_str() {
            Some("close") => break,
            Some("memory") => {
                let status = std::fs::read_to_string("/proc/self/status")?;
                let bytes = |key: &str| {
                    status
                        .lines()
                        .find_map(|line| line.strip_prefix(key))
                        .and_then(|v| v.split_whitespace().next())
                        .and_then(|v| v.parse::<u64>().ok())
                        .map(|kb| kb * 1024)
                        .ok_or_else(|| {
                            Error::invalid("Native memory diagnostics require Linux /proc")
                        })
                };
                output(json!({"rssBytes":bytes("VmRSS:")?,"maxRSSBytes":bytes("VmHWM:")?}))?;
            }
            _ => return Err(Error::invalid("Unknown fixture command")),
        }
    }
    running.close().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::serve::Listener;
    #[tokio::test]
    async fn gateway_accepts_control_streams_without_nagle_delays() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut listener = gateway_listener(listener);
        let (client, (accepted, _)) = tokio::join!(TcpStream::connect(address), listener.accept());
        let _client = client.unwrap();
        assert!(accepted.nodelay().unwrap());
    }

    #[tokio::test]
    async fn websocket_proxy_preserves_upgrade_and_immediate_bidirectional_frames() {
        use axum::{extract::WebSocketUpgrade, routing::get};
        use futures_util::{SinkExt, StreamExt};
        use std::time::Duration;
        use tokio_tungstenite::{connect_async, tungstenite::Message};
        let target = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = target.local_addr().unwrap();
        let app = Router::new().route(
            "/sync",
            get(|upgrade: WebSocketUpgrade| async {
                upgrade.on_upgrade(|mut socket| async move {
                    while let Some(Ok(message)) = socket.recv().await {
                        if socket.send(message).await.is_err() {
                            break;
                        }
                    }
                })
            }),
        );
        let backend = tokio::spawn(async move {
            axum::serve(gateway_listener(target), app).await.unwrap();
        });
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let proxy_address = listener.local_addr().unwrap();
        let app = Router::new().fallback(move |request: Request| async move {
            forward(request, address).await.unwrap()
        });
        let proxy = tokio::spawn(async move {
            axum::serve(gateway_listener(listener), app).await.unwrap();
        });
        for i in 0..100 {
            tokio::time::timeout(Duration::from_secs(3), async {
                let (mut socket, _) = connect_async(format!("ws://{proxy_address}/sync"))
                    .await
                    .unwrap();
                for expected in [
                    Message::Text(format!("control-{i}").into()),
                    Message::Binary(vec![42; 256 * 1024].into()),
                ] {
                    socket.send(expected.clone()).await.unwrap();
                    assert_eq!(socket.next().await.unwrap().unwrap(), expected);
                }
                socket.close(None).await.unwrap();
            })
            .await
            .expect("proxy handshake and duplex frames must make progress");
        }
        proxy.abort();
        backend.abort();
    }
}
