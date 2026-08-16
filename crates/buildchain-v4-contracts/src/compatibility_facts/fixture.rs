use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ContractResult;

use super::encoding::fault;
use super::verifier::verify_kungfu_temporal_path;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompatibilityFactsFixture {
    schema: String,
    cases: Vec<CompatibilityFactsFixtureCase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompatibilityFactsFixtureCase {
    id: String,
    bundle: Value,
    query: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatibilityFactsFixtureProjection {
    pub schema: &'static str,
    pub cases: Vec<CompatibilityFactsCaseProjection>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatibilityFactsCaseProjection {
    pub id: String,
    pub receipt: Value,
}

pub fn run_compatibility_facts_fixture(
    bytes: &[u8],
) -> ContractResult<CompatibilityFactsFixtureProjection> {
    let fixture: CompatibilityFactsFixture = serde_json::from_slice(bytes)
        .map_err(|error| fault("invalid-fixture", "$", error.to_string()))?;
    if fixture.schema != "buildchain.v4.compatibility-facts-fixture/v1" {
        return Err(fault(
            "invalid-fixture",
            "$.schema",
            "unsupported fixture schema",
        ));
    }
    let mut cases = Vec::new();
    for case in fixture.cases {
        cases.push(CompatibilityFactsCaseProjection {
            id: case.id,
            receipt: verify_kungfu_temporal_path(&case.bundle, &case.query)?,
        });
    }
    Ok(CompatibilityFactsFixtureProjection {
        schema: "buildchain.v4.compatibility-facts-projection/v1",
        cases,
    })
}
