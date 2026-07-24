const BADGE_BLOCK_START = "<!-- buildchain:badges:start -->";
const BADGE_BLOCK_END = "<!-- buildchain:badges:end -->";

function normalizeMarkdown(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function paragraphBlocks(markdown) {
  return normalizeMarkdown(markdown)
    .split(/\n{2,}/)
    .map((block) => block.replace(/\n/g, " ").trim())
    .filter(Boolean);
}

export function projectHomepageIntro(markdown) {
  const intro = normalizeMarkdown(markdown);
  const start = intro.indexOf(BADGE_BLOCK_START);
  const end = intro.indexOf(BADGE_BLOCK_END);
  if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) {
    throw new Error("README.md managed badge block is incomplete");
  }
  if (start >= 0) {
    const endOffset = end + BADGE_BLOCK_END.length;
    const lead = intro.slice(start, endOffset).trim();
    const remaining = [intro.slice(0, start), intro.slice(endOffset)]
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n\n");
    return {
      lead,
      mechanismSummary: paragraphBlocks(remaining),
    };
  }
  const blocks = paragraphBlocks(intro);
  return {
    lead: blocks[0] || "",
    mechanismSummary: blocks.slice(1),
  };
}
