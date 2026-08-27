use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value, json};

use crate::ContractResult;

use super::encoding::{
    KUNGFU_TEMPORAL_BUNDLE_SCHEMA, KUNGFU_TEMPORAL_PATH_QUERY_SCHEMA,
    KUNGFU_TEMPORAL_PATH_RECEIPT_SCHEMA, fault, is_root, kungfu_temporal_record_root, root_field,
    string_array, text_field,
};
use super::lifecycle::validate_lifecycle;

const MAX_PATH_DEPTH: u64 = 32;

fn fail<T>(code: &str, path: &str, message: &str) -> ContractResult<T> {
    Err(fault(code, path, message))
}

fn path_fail<T>(code: &str, message: &str) -> ContractResult<T> {
    fail(code, "$.relationPathRoots", message)
}

fn authority_fail<T>(code: &str, message: &str) -> ContractResult<T> {
    fail(code, "$.requiredAuthorityRoot", message)
}

#[derive(Clone)]
pub(super) struct Bundle {
    pub(super) cuts: BTreeMap<String, Value>,
    pub(super) predicates: BTreeMap<String, Value>,
    pub(super) relations: BTreeMap<String, Value>,
    pub(super) supersessions: BTreeMap<String, Value>,
    pub(super) revocations: BTreeMap<String, Value>,
    pub(super) authority_proofs: BTreeMap<String, Value>,
}

fn index_entries(document: &Value, field: &str) -> ContractResult<BTreeMap<String, Value>> {
    let entries = document
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| {
            fault(
                "invalid-bundle",
                &format!("$.{field}"),
                "family must be an array",
            )
        })?;
    let mut indexed = BTreeMap::new();
    for entry in entries {
        let object = entry
            .as_object()
            .filter(|object| {
                object.len() == 2 && object.contains_key("root") && object.contains_key("record")
            })
            .ok_or_else(|| {
                fault(
                    "invalid-bundle",
                    &format!("$.{field}"),
                    "entry requires root and record",
                )
            })?;
        let root = object["root"].as_str().ok_or_else(|| {
            fault(
                "invalid-bundle",
                &format!("$.{field}.root"),
                "root must be text",
            )
        })?;
        if kungfu_temporal_record_root(&object["record"])? != root {
            return fail(
                "root-mismatch",
                &format!("$.{field}"),
                "record root does not match bytes",
            );
        }
        if indexed
            .insert(root.to_owned(), object["record"].clone())
            .is_some()
        {
            return fail("ambiguous-root", &format!("$.{field}"), "duplicate root");
        }
    }
    Ok(indexed)
}

fn cut_arrays(cut: &Value, field: &str) -> ContractResult<Vec<String>> {
    let object = cut
        .as_object()
        .ok_or_else(|| fault("invalid-bundle", "$.cuts", "Cut must be an object"))?;
    let values = string_array(object, field)?;
    if values.iter().any(|value| !is_root(value))
        || values.iter().collect::<BTreeSet<_>>().len() != values.len()
    {
        return fail(
            "invalid-bundle",
            &format!("$.cuts.{field}"),
            "Cut roots must be unique roots",
        );
    }
    Ok(values)
}

fn ancestor(cuts: &BTreeMap<String, Value>, earlier: &str, later: &str) -> ContractResult<bool> {
    fn visit(
        cuts: &BTreeMap<String, Value>,
        earlier: &str,
        later: &str,
        visiting: &mut BTreeSet<String>,
    ) -> ContractResult<bool> {
        if earlier == later {
            return Ok(true);
        }
        if !visiting.insert(later.to_owned()) {
            return Err(fault("forbidden-cycle", "$.cuts", "Cut lineage is cyclic"));
        }
        let cut = cuts.get(later).ok_or_else(|| {
            fault(
                "orphan-root",
                "$.cuts",
                "Cut lineage references an unknown root",
            )
        })?;
        for parent in cut_arrays(cut, "parentCutRoots")? {
            if visit(cuts, earlier, &parent, visiting)? {
                visiting.remove(later);
                return Ok(true);
            }
        }
        visiting.remove(later);
        Ok(false)
    }
    visit(cuts, earlier, later, &mut BTreeSet::new())
}

fn assert_acyclic(cuts: &BTreeMap<String, Value>) -> ContractResult<()> {
    fn visit(
        cuts: &BTreeMap<String, Value>,
        root: &str,
        visiting: &mut BTreeSet<String>,
        visited: &mut BTreeSet<String>,
    ) -> ContractResult<()> {
        if visiting.contains(root) {
            return Err(fault("forbidden-cycle", "$.cuts", "Cut lineage is cyclic"));
        }
        if visited.contains(root) {
            return Ok(());
        }
        let cut = cuts
            .get(root)
            .ok_or_else(|| fault("orphan-root", "$.cuts", "Cut parent is absent"))?;
        visiting.insert(root.to_owned());
        for parent in cut_arrays(cut, "parentCutRoots")? {
            visit(cuts, &parent, visiting, visited)?;
        }
        visiting.remove(root);
        visited.insert(root.to_owned());
        Ok(())
    }
    let mut visited = BTreeSet::new();
    for root in cuts.keys() {
        visit(cuts, root, &mut BTreeSet::new(), &mut visited)?;
    }
    Ok(())
}

fn index_cuts(object: &Map<String, Value>) -> ContractResult<BTreeMap<String, Value>> {
    let mut cuts = BTreeMap::new();
    for cut in object["cuts"]
        .as_array()
        .ok_or_else(|| fault("invalid-bundle", "$.cuts", "cuts must be an array"))?
    {
        let cut_object = cut
            .as_object()
            .filter(|cut| {
                cut.len() == 4
                    && [
                        "root",
                        "parentCutRoots",
                        "activeRelationRoots",
                        "declarationRoots",
                    ]
                    .iter()
                    .all(|field| cut.contains_key(*field))
            })
            .ok_or_else(|| {
                fault(
                    "invalid-bundle",
                    "$.cuts",
                    "Cut projection has unexpected fields",
                )
            })?;
        let root = cut_object["root"]
            .as_str()
            .filter(|value| is_root(value))
            .ok_or_else(|| fault("orphan-root", "$.cuts.root", "invalid Cut root"))?;
        for field in ["parentCutRoots", "activeRelationRoots", "declarationRoots"] {
            cut_arrays(cut, field)?;
        }
        if cuts.insert(root.to_owned(), cut.clone()).is_some() {
            return Err(fault("ambiguous-root", "$.cuts", "duplicate Cut root"));
        }
    }
    assert_acyclic(&cuts)?;
    Ok(cuts)
}

fn validate_bundle_records(bundle: &Bundle) -> ContractResult<()> {
    for cut in bundle.cuts.values() {
        if cut_arrays(cut, "activeRelationRoots")?
            .iter()
            .any(|root| !bundle.relations.contains_key(root))
            || cut_arrays(cut, "declarationRoots")?
                .iter()
                .any(|root| !bundle.predicates.contains_key(root))
        {
            return fail("orphan-root", "$.cuts", "Cut references an unknown record");
        }
    }
    for relation in bundle.relations.values() {
        let relation = relation.as_object().expect("indexed records are objects");
        if !bundle
            .predicates
            .contains_key(root_field(relation, "predicateRoot")?)
        {
            return fail("unknown-predicate", "$.relations", "unknown predicate");
        }
        if !bundle
            .cuts
            .contains_key(root_field(relation, "validFromCutRoot")?)
        {
            return fail("orphan-root", "$.relations", "unknown valid-from Cut");
        }
    }
    for predicate in bundle.predicates.values() {
        let predicate = predicate.as_object().expect("indexed records are objects");
        if text_field(predicate, "direction")? != "source-to-target"
            || !["single-edge", "explicit-bounded"].contains(&text_field(predicate, "pathPolicy")?)
            || text_field(predicate, "cyclePolicy")? != "forbid"
            || string_array(predicate, "operations")?.is_empty()
        {
            return fail("invalid-record", "$.predicates", "invalid predicate policy");
        }
    }
    Ok(())
}

fn load_bundle(document: &Value) -> ContractResult<Bundle> {
    let object = document
        .as_object()
        .filter(|object| {
            object.len() == 8
                && object.get("schema").and_then(Value::as_str)
                    == Some(KUNGFU_TEMPORAL_BUNDLE_SCHEMA)
                && [
                    "cuts",
                    "predicates",
                    "relations",
                    "supersessions",
                    "revocations",
                    "authorityProofs",
                    "provenanceObjects",
                ]
                .iter()
                .all(|field| object.contains_key(*field))
        })
        .ok_or_else(|| {
            fault(
                "invalid-bundle",
                "$",
                "bundle fields do not match the closed schema",
            )
        })?;
    let bundle = Bundle {
        cuts: index_cuts(object)?,
        predicates: index_entries(document, "predicates")?,
        relations: index_entries(document, "relations")?,
        supersessions: index_entries(document, "supersessions")?,
        revocations: index_entries(document, "revocations")?,
        authority_proofs: index_entries(document, "authorityProofs")?,
    };
    validate_bundle_records(&bundle)?;
    validate_lifecycle(&bundle)?;
    Ok(bundle)
}

fn receipt(
    query: &Value,
    status: &str,
    failure_code: &str,
    mut authority_roots: Vec<String>,
) -> ContractResult<Value> {
    authority_roots.sort();
    authority_roots.dedup();
    let object = query.as_object().expect("query validated before receipt");
    let record = json!({
        "schema": KUNGFU_TEMPORAL_PATH_RECEIPT_SCHEMA,
        "queryRoot": kungfu_temporal_record_root(query)?,
        "status": status,
        "failureCode": failure_code,
        "cutRoot": object["cutRoot"],
        "relationPathRoots": object["relationPathRoots"],
        "authorityProofRoots": authority_roots,
        "omissionRoots": [],
    });
    Ok(json!({ "root": kungfu_temporal_record_root(&record)?, "record": record }))
}

struct PathPlan<'a> {
    cut: &'a Value,
    cut_root: String,
    predicate_root: String,
    required_authority: String,
    operation: String,
    relation_roots: Vec<String>,
}

fn validate_path_query<'a>(
    bundle: &'a Bundle,
    query: &Map<String, Value>,
) -> ContractResult<PathPlan<'a>> {
    let cut_root = root_field(query, "cutRoot")?.to_owned();
    let cut = bundle
        .cuts
        .get(&cut_root)
        .ok_or_else(|| fault("orphan-root", "$.cutRoot", "query Cut is absent"))?;
    let predicate_root = root_field(query, "predicateRoot")?.to_owned();
    let predicate_value = bundle
        .predicates
        .get(&predicate_root)
        .filter(|_| {
            cut_arrays(cut, "declarationRoots")
                .is_ok_and(|roots| roots.iter().any(|root| root == &predicate_root))
        })
        .ok_or_else(|| {
            fault(
                "unknown-predicate",
                "$.predicateRoot",
                "predicate is not declared at Cut",
            )
        })?;
    let predicate = predicate_value
        .as_object()
        .expect("indexed records are objects");
    let required_authority = root_field(query, "requiredAuthorityRoot")?.to_owned();
    if root_field(predicate, "authorityRoot")? != required_authority {
        return authority_fail(
            "authority-missing",
            "query authority does not own predicate",
        );
    }
    let operation = text_field(query, "operation")?.to_owned();
    if !string_array(predicate, "operations")?
        .iter()
        .any(|value| value == &operation)
    {
        return fail(
            "unscoped-compatibility",
            "$.operation",
            "operation is outside predicate scope",
        );
    }
    let relation_roots = string_array(query, "relationPathRoots")?;
    let max_depth = query.get("maxDepth").and_then(Value::as_u64).unwrap_or(0);
    if max_depth == 0 || max_depth > MAX_PATH_DEPTH || relation_roots.len() as u64 > max_depth {
        return path_fail("path-bound-exceeded", "path exceeds verifier bound");
    }
    if relation_roots.is_empty() {
        return path_fail("path-missing", "verifier does not search for a path");
    }
    if relation_roots.iter().collect::<BTreeSet<_>>().len() != relation_roots.len() {
        return path_fail("forbidden-cycle", "a relation repeats");
    }
    if relation_roots.len() > 1 && text_field(predicate, "pathPolicy")? != "explicit-bounded" {
        return path_fail(
            "implicit-transitive-acceptance",
            "composed paths are forbidden",
        );
    }
    Ok(PathPlan {
        cut,
        cut_root,
        predicate_root,
        required_authority,
        operation,
        relation_roots,
    })
}

fn relation_authority_proof(
    bundle: &Bundle,
    plan: &PathPlan<'_>,
    relation: &Map<String, Value>,
) -> ContractResult<Option<String>> {
    if root_field(relation, "authorityRoot")? == plan.required_authority {
        return Ok(None);
    }
    let mut matches = Vec::new();
    for (root, proof_value) in &bundle.authority_proofs {
        let proof = proof_value
            .as_object()
            .expect("indexed records are objects");
        let revoked = proof.get("revokedAtCutRoot").and_then(Value::as_str);
        if root_field(proof, "subjectAuthorityRoot")? == root_field(relation, "authorityRoot")?
            && root_field(proof, "governingAuthorityRoot")? == plan.required_authority
            && string_array(proof, "operations")?
                .iter()
                .any(|value| value == &plan.operation)
            && ancestor(
                &bundle.cuts,
                root_field(proof, "validFromCutRoot")?,
                &plan.cut_root,
            )?
            && match revoked {
                Some(cut) => !ancestor(&bundle.cuts, cut, &plan.cut_root)?,
                None => true,
            }
        {
            matches.push(root.clone());
        }
    }
    match matches.len() {
        0 => authority_fail("authority-missing", "no authority proof applies"),
        1 => Ok(matches.pop()),
        _ => authority_fail(
            "ambiguous-authority",
            "more than one authority proof applies",
        ),
    }
}

fn verify_relation_step(
    bundle: &Bundle,
    plan: &PathPlan<'_>,
    relation_root: &str,
    cursor: &str,
    endpoints: &mut BTreeSet<String>,
) -> ContractResult<(String, Option<String>)> {
    let relation = bundle
        .relations
        .get(relation_root)
        .ok_or_else(|| fault("orphan-root", "$.relationPathRoots", "unknown relation"))?
        .as_object()
        .expect("indexed records are objects");
    if !ancestor(
        &bundle.cuts,
        root_field(relation, "validFromCutRoot")?,
        &plan.cut_root,
    )? {
        return fail(
            "relation-not-yet-valid",
            "$.cutRoot",
            "relation is not valid at Cut",
        );
    }
    for record in bundle.supersessions.values() {
        let record = record.as_object().expect("indexed records are objects");
        if root_field(record, "priorRelationRoot")? == relation_root
            && ancestor(
                &bundle.cuts,
                root_field(record, "effectiveCutRoot")?,
                &plan.cut_root,
            )?
        {
            return path_fail("relation-superseded", "relation was superseded");
        }
    }
    for record in bundle.revocations.values() {
        let record = record.as_object().expect("indexed records are objects");
        if root_field(record, "relationRoot")? == relation_root
            && ancestor(
                &bundle.cuts,
                root_field(record, "effectiveCutRoot")?,
                &plan.cut_root,
            )?
        {
            return path_fail("relation-revoked", "relation was revoked");
        }
    }
    if !cut_arrays(plan.cut, "activeRelationRoots")
        .expect("Cut arrays validated while loading the bundle")
        .iter()
        .any(|root| root == relation_root)
    {
        return path_fail("relation-inactive-at-cut", "relation is inactive");
    }
    if root_field(relation, "predicateRoot")? != plan.predicate_root {
        return fail(
            "predicate-mismatch",
            "$.predicateRoot",
            "path crosses predicates",
        );
    }
    if root_field(relation, "sourceRoot")? != cursor {
        return path_fail(
            "direction-mismatch",
            "relation direction does not match path",
        );
    }
    let target = root_field(relation, "targetRoot")?.to_owned();
    if !endpoints.insert(target.clone()) {
        return path_fail("forbidden-cycle", "path repeats an endpoint");
    }
    Ok((target, relation_authority_proof(bundle, plan, relation)?))
}

fn verify_path_inner(
    bundle: &Bundle,
    query: &Map<String, Value>,
    authority_roots: &mut Vec<String>,
) -> ContractResult<()> {
    let plan = validate_path_query(bundle, query)?;
    let mut cursor = root_field(query, "sourceRoot")?.to_owned();
    let mut endpoints = BTreeSet::from([cursor.clone()]);
    for relation_root in &plan.relation_roots {
        let (target, authority_root) =
            verify_relation_step(bundle, &plan, relation_root, &cursor, &mut endpoints)?;
        cursor = target;
        authority_roots.extend(authority_root);
    }
    if cursor != root_field(query, "targetRoot")? {
        return fail(
            "direction-mismatch",
            "$.targetRoot",
            "explicit path does not reach target",
        );
    }
    Ok(())
}

pub fn verify_kungfu_temporal_path(document: &Value, query: &Value) -> ContractResult<Value> {
    if query.get("schema").and_then(Value::as_str) != Some(KUNGFU_TEMPORAL_PATH_QUERY_SCHEMA) {
        return fail(
            "unknown-schema",
            "$.schema",
            "query schema is not supported",
        );
    }
    kungfu_temporal_record_root(query)?;
    let mut authority_roots = Vec::new();
    match load_bundle(document).and_then(|bundle| {
        verify_path_inner(
            &bundle,
            query.as_object().expect("record root requires an object"),
            &mut authority_roots,
        )
    }) {
        Ok(()) => receipt(query, "accepted", "", authority_roots),
        Err(error) => receipt(query, "rejected", &error.code, authority_roots),
    }
}
