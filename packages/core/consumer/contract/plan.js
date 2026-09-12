import { parse } from "smol-toml";
import { choice, list, object, relativePath, text, unique } from "./shape.js";
import { compileProducts } from "./products.js";

export const CONSUMER_CONTRACT = "buildchain.consumer-contract/v2";
export const CONSUMER_PLAN = "buildchain.consumer-plan/v1";
export const CONFIG_PATH = ".buildchain/buildchain.toml";

function compileVersion(value) {
  object(value, ["strategy", "files"], ["derived_files"], "version");
  choice(value.strategy, ["semver", "anchored"], "version.strategy");
  list(value.files, "version.files", (item, field) => {
    object(item, ["path", "format", "key"], [], field);
    relativePath(item.path, `${field}.path`);
    choice(item.format, ["json", "toml"], `${field}.format`);
    text(item.key, `${field}.key`, /^[A-Za-z0-9_.-]+$/u);
  });
  unique(
    value.files.map((item) => `${item.path}:${item.key}`),
    "version.files",
  );
  if (value.derived_files !== undefined)
    list(value.derived_files, "version.derived_files", relativePath);
  return structuredClone(value);
}

function compileChannels(values) {
  const channels = list(values, "channels", (value, field) => {
    object(value, ["from", "to", "operation"], [], field);
    text(
      value.from,
      `${field}.from`,
      /^(?:feature|dev|alpha|release)\/[A-Za-z0-9/*._-]+$/u,
    );
    text(
      value.to,
      `${field}.to`,
      /^(?:dev|alpha|release|publish-gate)\/[A-Za-z0-9/._-]+$/u,
    );
    choice(
      value.operation,
      ["develop", "alpha", "stable", "major"],
      `${field}.operation`,
    );
    const source = value.from.split("/")[0],
      target = value.to.split("/")[0];
    const legal = {
      develop: source === "feature" && target === "dev",
      alpha: source === "dev" && target === "alpha",
      stable: source === "alpha" && target === "release",
      major: source === "release" && value.to === "publish-gate/major",
    };
    if (
      !legal[value.operation] ||
      value.from.includes("..") ||
      value.to.includes("..")
    )
      throw new Error(`${field}: unlawful channel route`);
    return { ...value };
  });
  unique(
    channels.map((value) => `${value.from}:${value.to}`),
    "channels",
  );
  return channels;
}

function compileReview(value) {
  object(
    value,
    ["minimum_approvals", "code_owners", "merge_queue"],
    [],
    "review",
  );
  if (!Number.isInteger(value.minimum_approvals) || value.minimum_approvals < 1)
    throw new Error(
      "review.minimum_approvals: independent approval is required",
    );
  if (value.code_owners !== true || value.merge_queue !== true)
    throw new Error(
      "review: code owners and protected merge queue are required",
    );
  return { ...value };
}

// This compiler receives bytes. It has no filesystem, process, network or provider port.
export function compileConsumerPlan(source) {
  const config = parse(source);
  object(config, ["schema", "products", "version", "channels", "review"]);
  choice(config.schema, [2], "schema");
  return {
    schema: CONSUMER_PLAN,
    contract: CONSUMER_CONTRACT,
    products: compileProducts(config.products),
    version: compileVersion(config.version),
    channels: compileChannels(config.channels),
    review: compileReview(config.review),
  };
}
