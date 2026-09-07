use std::collections::{BTreeMap, BTreeSet};

use crate::ContractResult;

use super::encoding::{fault, root_field};
use super::verifier::Bundle;

pub(super) fn validate_lifecycle(bundle: &Bundle) -> ContractResult<()> {
    let mut edges: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for record in bundle.supersessions.values() {
        let record = record.as_object().expect("indexed records are objects");
        let prior = root_field(record, "priorRelationRoot")?;
        let successor = root_field(record, "successorRelationRoot")?;
        let cut = root_field(record, "effectiveCutRoot")?;
        if !bundle.relations.contains_key(prior)
            || !bundle.relations.contains_key(successor)
            || !bundle.cuts.contains_key(cut)
        {
            return Err(fault(
                "orphan-root",
                "$.supersessions",
                "unknown lifecycle root",
            ));
        }
        edges
            .entry(prior.to_owned())
            .or_default()
            .push(successor.to_owned());
    }
    fn visit(
        edges: &BTreeMap<String, Vec<String>>,
        current: &str,
        visiting: &mut BTreeSet<String>,
        visited: &mut BTreeSet<String>,
    ) -> ContractResult<()> {
        if !visiting.insert(current.to_owned()) {
            return Err(fault(
                "forbidden-cycle",
                "$.supersessions",
                "supersession records form a cycle",
            ));
        }
        if visited.contains(current) {
            visiting.remove(current);
            return Ok(());
        }
        for next in edges.get(current).into_iter().flatten() {
            visit(edges, next, visiting, visited)?;
        }
        visiting.remove(current);
        visited.insert(current.to_owned());
        Ok(())
    }
    let mut visited = BTreeSet::new();
    for current in edges.keys() {
        visit(&edges, current, &mut BTreeSet::new(), &mut visited)?;
    }
    for record in bundle.revocations.values() {
        let record = record.as_object().expect("indexed records are objects");
        if !bundle
            .relations
            .contains_key(root_field(record, "relationRoot")?)
            || !bundle
                .cuts
                .contains_key(root_field(record, "effectiveCutRoot")?)
        {
            return Err(fault(
                "orphan-root",
                "$.revocations",
                "unknown revocation root",
            ));
        }
    }
    Ok(())
}
