//! Disposable source ownership indexes. Observe the live document, including
//! server corrections, rather than updating a cache from proposed client bytes.
use crate::crdt::{Ids, get, root, string, value};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use yrs::{
    DeepObservable, Doc, Map, Out, ReadTxn, Subscription, Transact,
    types::{Event, PathSegment},
};

#[derive(Default)]
struct Owners {
    by_id: BTreeMap<String, String>,
    by_source: BTreeMap<String, Ids>,
}
impl Owners {
    fn update<T: ReadTxn>(&mut self, tx: &T, name: &str, id: &str) {
        if let Some(old) = self.by_id.remove(id) {
            let entries = self.by_source.get_mut(&old).expect("indexed owner");
            entries.remove(id);
            if entries.is_empty() {
                self.by_source.remove(&old);
            }
        }
        let owner = match root(tx, name).get(tx, id) {
            Some(Out::YMap(map)) => map.get(tx, "noteId").map(|v| value(tx, &v)),
            Some(v) => Some(value(tx, &v)["noteId"].clone()),
            None => None,
        };
        if let Some(owner) = owner
            .as_ref()
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            self.by_id.insert(id.into(), owner.into());
            self.by_source
                .entry(owner.into())
                .or_default()
                .insert(id.into());
        }
    }
}

pub(crate) struct OwnedRecords {
    name: &'static str,
    owners: Arc<Mutex<Owners>>,
    _subscription: Subscription,
}
impl OwnedRecords {
    pub fn new(doc: &Doc, name: &'static str) -> Self {
        let owners = Arc::new(Mutex::new(Owners::default()));
        let tx = doc.transact();
        let map = root(&tx, name);
        for id in map.keys(&tx) {
            owners
                .lock()
                .expect("ownership index")
                .update(&tx, name, id);
        }
        drop(tx);
        let observed = owners.clone();
        let subscription = map.observe_deep(move |tx, events| {
            let mut changed = Ids::new();
            for event in events.iter() {
                if let Some(PathSegment::Key(id)) = event.path().front() {
                    changed.insert(id.to_string());
                } else if let Event::Map(event) = event {
                    changed.extend(event.keys(tx).keys().map(ToString::to_string));
                }
            }
            let mut owners = observed.lock().expect("ownership index");
            for id in changed {
                owners.update(tx, name, &id);
            }
        });
        Self {
            name,
            owners,
            _subscription: subscription,
        }
    }
    pub fn entries<T: ReadTxn>(&self, tx: &T, sources: &Ids) -> Vec<(String, serde_json::Value)> {
        let owners = self.owners.lock().expect("ownership index");
        sources
            .iter()
            .flat_map(|source| owners.by_source.get(source).into_iter().flatten())
            .map(|id| (id.clone(), get(tx, self.name, id)))
            // Check ownership at the read boundary too; this index never grants access.
            .filter(|(_, v)| sources.contains(string(&v["noteId"])))
            .collect()
    }
}
