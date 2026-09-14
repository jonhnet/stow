//! A lease keeps the exact cached entry alive through requests, queued writes and connections.
use crate::error::{Error, Result};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
struct Entry<T> {
    value: Mutex<T>,
    users: AtomicUsize,
    idle_since: Mutex<Instant>,
}
pub struct Lease<T> {
    entry: Arc<Entry<T>>,
}
impl<T> Lease<T> {
    pub fn lock(&self) -> Result<std::sync::MutexGuard<'_, T>> {
        self.entry
            .value
            .lock()
            .map_err(|_| Error::invalid("Vault unavailable"))
    }
}
impl<T> Drop for Lease<T> {
    fn drop(&mut self) {
        *self.entry.idle_since.lock().expect("cache clock") = Instant::now();
        self.entry.users.fetch_sub(1, Ordering::Release);
    }
}
pub struct Cache<T> {
    entries: Mutex<BTreeMap<String, Arc<Entry<T>>>>,
    stopped: AtomicBool,
    idle: Duration,
}
impl<T> Default for Cache<T> {
    fn default() -> Self {
        Self::new(Duration::from_secs(30))
    }
}
impl<T> Cache<T> {
    pub fn new(idle: Duration) -> Self {
        Self {
            entries: Mutex::new(BTreeMap::new()),
            stopped: AtomicBool::new(false),
            idle,
        }
    }
    pub fn acquire(&self, id: &str, open: impl FnOnce() -> Result<T>) -> Result<Lease<T>> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| Error::invalid("Vault registry unavailable"))?;
        if self.stopped.load(Ordering::Acquire) {
            return Err(Error::invalid("The vault server is closing."));
        }
        let entry = if let Some(e) = entries.get(id) {
            e.clone()
        } else {
            let e = Arc::new(Entry {
                value: Mutex::new(open()?),
                users: AtomicUsize::new(0),
                idle_since: Mutex::new(Instant::now()),
            });
            entries.insert(id.into(), e.clone());
            e
        };
        entry.users.fetch_add(1, Ordering::Acquire);
        Ok(Lease { entry })
    }
    pub fn evict(&self) -> Result<()> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| Error::invalid("Vault registry unavailable"))?;
        entries.retain(|_, e| {
            e.users.load(Ordering::Acquire) > 0
                || e.idle_since
                    .lock()
                    .map(|t| t.elapsed() < self.idle)
                    .unwrap_or(true)
        });
        Ok(())
    }
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
    }
    pub fn close(&self) {
        self.stop();
        if let Ok(mut entries) = self.entries.lock() {
            entries.clear();
        }
    }
    #[cfg(feature = "test-support")]
    pub fn count(&self) -> usize {
        self.entries.lock().unwrap().len()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn held_and_waiting_writes_survive_eviction() {
        let cache = Cache::new(Duration::ZERO);
        let first = cache.acquire("a", || Ok(0)).unwrap();
        let same = cache.acquire("a", || panic!("opened twice")).unwrap();
        assert!(Arc::ptr_eq(&first.entry, &same.entry));
        let original = Arc::downgrade(&first.entry);
        let guard = first.lock().unwrap();
        let queued = cache.acquire("a", || unreachable!()).unwrap();
        drop(same);
        cache.evict().unwrap();
        assert!(original.upgrade().is_some());
        drop(guard);
        *queued.lock().unwrap() = 42;
        drop(first);
        cache.evict().unwrap();
        assert_eq!(*queued.lock().unwrap(), 42);
        drop(queued);
        cache.evict().unwrap();
        assert!(original.upgrade().is_none());
        let reopened = cache.acquire("a", || Ok(42)).unwrap();
        assert_eq!(*reopened.lock().unwrap(), 42);
    }
    #[test]
    fn failed_open_retry_and_stop() {
        let cache = Cache::<u8>::default();
        assert!(
            cache
                .acquire("a", || Err(Error::invalid("disk unavailable")))
                .is_err()
        );
        let held = cache.acquire("a", || Ok(1)).unwrap();
        cache.stop();
        assert!(cache.acquire("b", || Ok(2)).is_err());
        cache.close();
        assert_eq!(*held.lock().unwrap(), 1);
    }

    #[test]
    fn queued_disk_write_finishes_on_original_vault_before_eviction_and_reopen() {
        use crate::{crdt, storage::Vault};
        use yrs::{Map, ReadTxn, Transact};
        let directory = tempfile::tempdir().unwrap();
        let cache = Arc::new(Cache::new(Duration::ZERO));
        let first = cache
            .acquire("a", || Vault::open(directory.path(), 0.0))
            .unwrap();
        let original = Arc::downgrade(&first.entry);
        let guard = first.lock().unwrap();
        let client = crdt::new_doc();
        client
            .get_or_insert_map("values")
            .insert(&mut client.transact_mut(), "saved", "durable");
        let update = crdt::encode(&client);
        let (admitted, waiting) = std::sync::mpsc::channel();
        let (written, committed) = std::sync::mpsc::channel();
        let (release, finish) = std::sync::mpsc::channel();
        let worker_cache = cache.clone();
        let worker = std::thread::spawn(move || {
            let lease = worker_cache
                .acquire("a", || panic!("queued write reopened the vault"))
                .unwrap();
            admitted.send(()).unwrap();
            lease.lock().unwrap().accept(&update, 1.0).unwrap();
            written.send(()).unwrap();
            finish.recv().unwrap();
        });
        waiting.recv().unwrap();
        cache.evict().unwrap();
        assert!(original.upgrade().is_some());
        drop(guard);
        drop(first);
        committed.recv().unwrap();
        cache.evict().unwrap();
        let reader = cache
            .acquire("a", || panic!("evicted an active lease"))
            .unwrap();
        assert!(Arc::ptr_eq(&reader.entry, &original.upgrade().unwrap()));
        drop(reader);
        release.send(()).unwrap();
        worker.join().unwrap();
        cache.evict().unwrap();
        assert!(original.upgrade().is_none());
        let reopened = cache
            .acquire("a", || Vault::open(directory.path(), 2.0))
            .unwrap();
        let vault = reopened.lock().unwrap();
        assert_eq!(
            crdt::get(&vault.doc.transact(), "values", "saved"),
            "durable"
        );
        let other_dir = tempfile::tempdir().unwrap();
        let other = cache
            .acquire("b", || Vault::open(other_dir.path(), 2.0))
            .unwrap();
        assert!(
            other
                .lock()
                .unwrap()
                .doc
                .transact()
                .get_map("values")
                .is_none()
        );
    }

    #[test]
    fn idle_clock_starts_after_the_last_lease() {
        let cache = Cache::<u8>::default();
        let lease = cache.acquire("a", || Ok(0)).unwrap();
        let original = Arc::downgrade(&lease.entry);
        *lease.entry.idle_since.lock().unwrap() = Instant::now() - Duration::from_secs(60);
        cache.evict().unwrap();
        assert!(original.upgrade().is_some());
        drop(lease);
        cache.evict().unwrap();
        assert!(
            original.upgrade().is_some(),
            "active lifetime must not count toward idle time"
        );
        *original.upgrade().unwrap().idle_since.lock().unwrap() =
            Instant::now() - Duration::from_secs(31);
        cache.evict().unwrap();
        assert!(original.upgrade().is_none());
    }
}
