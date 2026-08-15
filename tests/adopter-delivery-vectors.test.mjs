import assert from "node:assert/strict";
import test from "node:test";

import {
  ADOPTER_DELIVERY_VECTOR_SUITE,
  ADOPTER_DELIVERY_VECTOR_SUITE_CONTRACT,
  getAdopterDeliveryVector,
  validateAdopterDeliveryVectorSuite,
} from "@kungfu-tech/buildchain/adopter-delivery-vectors";

test("public adopter delivery vectors are immutable and root-complete", () => {
  assert.equal(
    ADOPTER_DELIVERY_VECTOR_SUITE.contract,
    ADOPTER_DELIVERY_VECTOR_SUITE_CONTRACT,
  );
  assert.deepEqual(
    validateAdopterDeliveryVectorSuite(ADOPTER_DELIVERY_VECTOR_SUITE),
    {
      valid: true,
      issues: [],
    },
  );
  assert.equal(Object.isFrozen(ADOPTER_DELIVERY_VECTOR_SUITE), true);
  assert.equal(Object.isFrozen(ADOPTER_DELIVERY_VECTOR_SUITE.cases), true);
  assert.deepEqual(
    new Set(ADOPTER_DELIVERY_VECTOR_SUITE.cases.map(({ class: kind }) => kind)),
    new Set(["golden", "negative", "fault"]),
  );
});

test("vector root and required case closure fail closed after substitution", () => {
  const changed = structuredClone(ADOPTER_DELIVERY_VECTOR_SUITE);
  changed.cases[0].expected.qualifying = true;
  const changedValidation = validateAdopterDeliveryVectorSuite(changed);
  assert.equal(changedValidation.valid, false);
  assert.ok(
    changedValidation.issues.some(
      ({ code }) => code === "adopter-delivery-vectors.root",
    ),
  );

  const missing = structuredClone(ADOPTER_DELIVERY_VECTOR_SUITE);
  missing.cases = missing.cases.filter(({ id }) => id !== "fault-driver-throw");
  const missingValidation = validateAdopterDeliveryVectorSuite(missing);
  assert.equal(missingValidation.valid, false);
  assert.ok(
    missingValidation.issues.some(
      ({ code }) => code === "adopter-delivery-vectors.required-case",
    ),
  );
  assert.throws(
    () => getAdopterDeliveryVector("unknown-vector"),
    /Unknown adopter delivery vector/,
  );
});
