const targets = [
  { pattern: /^alpha\/v\d+\/v\d+\.\d+$/, publicationChannel: "alpha", channel: "alpha" },
  { pattern: /^release\/v\d+\/v\d+\.\d+$/, publicationChannel: "release", channel: "stable" },
  { pattern: /^publish-gate\/major$/, publicationChannel: "major", channel: "stable" },
];

// Publication intent belongs to the product branch. Runtime selection belongs
// to the entry and cannot be inferred again from the publication channel.
export function resolvePromotionChannel({ targetRef = "", publicationChannel = "" } = {}) {
  const ref = String(targetRef).replace(/^refs\/heads\//u, "");
  const target = targets.find(({ pattern }) => pattern.test(ref));
  if (!target) throw new Error(`unsupported promotion target ref: ${ref || "<empty>"}`);
  if (publicationChannel && publicationChannel !== target.publicationChannel)
    throw new Error(`promotion channel ${publicationChannel} does not match target ref ${ref}`);
  return { targetRef: ref, publicationChannel: target.publicationChannel, channel: target.channel };
}
