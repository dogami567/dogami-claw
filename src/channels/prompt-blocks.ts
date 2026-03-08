const MARKER_BLOCK_RE = /^<([a-z][a-z0-9_-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>$/i;

function resolvePromptBlockKey(block: string): string {
  const markerMatch = block.match(MARKER_BLOCK_RE);
  if (markerMatch) {
    return `marker:${markerMatch[1].toLowerCase()}`;
  }
  return `text:${block}`;
}

export function joinPromptBlocks(
  blocks: Array<string | null | undefined>,
  separator = "\n\n",
): string {
  const orderedKeys: string[] = [];
  const valuesByKey = new Map<string, string>();

  for (const raw of blocks) {
    const block = raw?.trim();
    if (!block) continue;
    const key = resolvePromptBlockKey(block);
    if (valuesByKey.has(key)) {
      const index = orderedKeys.indexOf(key);
      if (index >= 0) orderedKeys.splice(index, 1);
    }
    orderedKeys.push(key);
    valuesByKey.set(key, block);
  }

  return orderedKeys
    .map((key) => valuesByKey.get(key) ?? "")
    .filter(Boolean)
    .join(separator);
}
