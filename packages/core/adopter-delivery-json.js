import crypto from "node:crypto";

export function isAdopterDeliveryJsonValue(value, ancestors = new Set()) {
  try {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      return true;
    }
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object" || ancestors.has(value)) return false;

    ancestors.add(value);
    let valid = true;
    if (Array.isArray(value)) {
      valid =
        Reflect.ownKeys(value).length === value.length + 1 &&
        Array.from(
          { length: value.length },
          (_, index) =>
            Object.hasOwn(value, index) &&
            isAdopterDeliveryJsonValue(value[index], ancestors),
        ).every(Boolean);
    } else {
      const prototype = Object.getPrototypeOf(value);
      const keys = Reflect.ownKeys(value);
      valid =
        (prototype === Object.prototype || prototype === null) &&
        keys.every((key) => {
          if (typeof key !== "string") return false;
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          return (
            descriptor?.enumerable === true &&
            Object.hasOwn(descriptor, "value") &&
            isAdopterDeliveryJsonValue(descriptor.value, ancestors)
          );
        });
    }
    ancestors.delete(value);
    return valid;
  } catch {
    return false;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function adopterDeliveryGateDigest(value) {
  if (!isAdopterDeliveryJsonValue(value)) {
    throw new TypeError(
      "delivery gate digests require finite acyclic JSON values",
    );
  }
  return `sha256:${crypto.createHash("sha256").update(stableJson(value)).digest("hex")}`;
}
