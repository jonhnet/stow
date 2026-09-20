//! Shared merge connectivity. Roots are internal; callers retain their own
//! visible source ordering and retention eligibility rules.
use crate::crdt::{Ids, entries, record_scan, string};
use std::collections::BTreeMap;
use yrs::ReadTxn;

pub(crate) fn roots<T: ReadTxn>(tx: &T, live: &Ids, deleted: &Ids) -> BTreeMap<String, String> {
    resolve(
        live.union(deleted).cloned().collect(),
        entries(tx, "merges", None)
            .into_iter()
            .map(|(_, edge)| (string(&edge["a"]).to_owned(), string(&edge["b"]).to_owned())),
    )
}
fn resolve(
    ids: Ids,
    edges: impl IntoIterator<Item = (String, String)>,
) -> BTreeMap<String, String> {
    let names: Vec<_> = ids.into_iter().collect();
    let indices: BTreeMap<_, _> = names
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();
    let mut parents: Vec<_> = (0..names.len()).collect();
    let mut sizes = vec![1usize; names.len()];
    fn find(parents: &mut [usize], mut id: usize) -> usize {
        let mut root = id;
        while parents[root] != root {
            record_scan("componentParentSteps");
            root = parents[root];
        }
        while parents[id] != root {
            record_scan("componentParentSteps");
            let next = parents[id];
            parents[id] = root;
            id = next;
        }
        root
    }
    for (a, b) in edges {
        if let (Some(&a), Some(&b)) = (indices.get(a.as_str()), indices.get(b.as_str())) {
            let (mut a, mut b) = (find(&mut parents, a), find(&mut parents, b));
            if a == b {
                continue;
            }
            if sizes[a] < sizes[b] {
                std::mem::swap(&mut a, &mut b);
            }
            parents[b] = a;
            sizes[a] += sizes[b];
        }
    }
    names
        .iter()
        .enumerate()
        .map(|(i, id)| (id.clone(), names[find(&mut parents, i)].clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crdt::take_scans;

    #[test]
    fn long_merge_chains_have_bounded_parent_traversal() {
        for count in [128, 512, 2048] {
            let ids: Ids = (0..count).map(|i| format!("n{i:04}")).collect();
            let edges = (1..count).map(|i| (format!("n{i:04}"), format!("n{:04}", i - 1)));
            take_scans();
            let roots = resolve(ids, edges);
            let steps = take_scans()
                .get("componentParentSteps")
                .copied()
                .unwrap_or(0);
            assert!(roots.values().all(|root| root == &roots["n0000"]));
            assert!(
                steps < count * 8,
                "{count} sources took {steps} parent steps"
            );
        }
    }

    #[test]
    fn edge_order_cycles_duplicates_and_unknown_endpoints_preserve_partitions() {
        let ids: Ids = ["a", "b", "c", "d", "e", "f"]
            .into_iter()
            .map(str::to_owned)
            .collect();
        let edges: Vec<_> = [
            ("a", "b"),
            ("b", "c"),
            ("c", "a"),
            ("a", "b"),
            ("d", "d"),
            ("e", "f"),
            ("c", "missing"),
            ("missing", "d"),
        ]
        .into_iter()
        .map(|(a, b)| (a.to_owned(), b.to_owned()))
        .collect();
        for reverse in [false, true] {
            for rotation in 0..edges.len() {
                let mut edges = edges.clone();
                edges.rotate_left(rotation);
                if reverse {
                    edges.reverse();
                }
                let roots = resolve(ids.clone(), edges);
                let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
                for (id, root) in roots {
                    groups.entry(root).or_default().push(id);
                }
                let mut actual: Vec<_> = groups.into_values().collect();
                actual.sort();
                assert_eq!(actual, vec![vec!["a", "b", "c"], vec!["d"], vec!["e", "f"]]);
            }
        }
    }
}
