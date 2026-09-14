use stow_server::{
    error::Result,
    server::{Config, start},
};
fn main() {
    // Offline commands do not need an async runtime or its worker threads.
    let result = if std::env::args().nth(1).as_deref() == Some("bridge") {
        stow_server::bridge::run()
    } else if std::env::args().nth(1).as_deref() == Some("reset-account") {
        stow_server::admin::reset(std::env::args().skip(2))
    } else {
        tokio::runtime::Runtime::new()
            .map_err(stow_server::error::Error::from)
            .and_then(|runtime| runtime.block_on(run()))
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
async fn run() -> Result<()> {
    if std::env::args().nth(1).as_deref() == Some("check-image") {
        use std::io::{Read, Write};
        let mut bytes = Vec::new();
        std::io::stdin()
            .take((stow_server::server::MAX_BLOB + 1) as u64)
            .read_to_end(&mut bytes)?;
        if bytes.len() > stow_server::server::MAX_BLOB {
            return Err(stow_server::error::Error::invalid(
                "Attachment is too large",
            ));
        }
        let thumbnail = stow_server::images::render(&bytes).await?;
        std::io::stdout().write_all(&thumbnail)?;
        return Ok(());
    }
    let running = start(Config::from_env()?).await?;
    println!("Stow listening on http://{}", running.address);
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! { _=tokio::signal::ctrl_c()=>{},_=terminate.recv()=>{} }
    running.close().await
}
