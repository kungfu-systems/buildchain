function replaceRequired(source, before, after) {
  if (
    !source.includes(before) ||
    source.indexOf(before) !== source.lastIndexOf(before)
  )
    throw new Error(
      "Historical promotion adapter no longer matches its maintained component",
    );
  return source.replace(before, after);
}

export function adaptHistoricalPromotionWorkflow(entry, source) {
  if (entry.adapter === "promotion-v4.0") {
    source = replaceRequired(
      source,
      "          runtime-ref: ${{ inputs.runtime-ref }}\n",
      "          runtime-ref: ${{ inputs.runtime-ref }}\n          compatibility-inputs: ${{ toJSON(inputs) }}\n",
    );
    source = replaceRequired(
      source,
      "          request-json: ${{ inputs.request-json }}",
      `          request-json: \${{ format('{{"schema":"buildchain.promotion-compatibility/v1","inputs":{0}}}', toJSON(inputs)) }}`,
    );
    source = replaceRequired(
      source,
      "      request-json: ${{ steps.node.outputs.request-json }}",
      "      request-json: ${{ steps.node.outputs.request-json }}\n      historical-inputs-json: ${{ steps.node.outputs.historical-inputs-json }}",
    );
    return replaceRequired(
      source,
      "uses: ./.github/workflows/.release-promote.yml",
      "uses: ./.github/workflows/.release-historical.yml",
    );
  }
  if (entry.adapter === "promotion-backbone") {
    return replaceRequired(
      source,
      "      actions: read\n      contents: read\n      discussions: read\n      pull-requests: read\n",
      "      actions: read\n      contents: read\n",
    );
  }
  return source;
}
