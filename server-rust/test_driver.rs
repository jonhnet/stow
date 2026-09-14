#[tokio::main(worker_threads = 2)]
async fn main() {
    if let Err(error) = stow_server::fixture::run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
