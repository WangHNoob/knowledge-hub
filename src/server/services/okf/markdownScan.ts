// src/server/services/okf/markdownScan.ts

export interface MarkdownScan {
  obsidian: string[]; // inner text of each [[...]]
  bundleLinks: string[]; // standard md links whose target is a bundle-relative /....md path
  hasCitations: boolean; // body contains a "# Citations" heading
}

const OBSIDIAN_RE = /\[\[([^\]]+)\]\]/gu;
const MD_BUNDLE_LINK_RE = /\[[^\]]*\]\((\/[^)]+\.md)\)/gu;
const CITATIONS_RE = /^#\s+Citations\s*$/mu;

export function scanMarkdown(body: string): MarkdownScan {
  const obsidian: string[] = [];
  const bundleLinks: string[] = [];
  for (const m of body.matchAll(OBSIDIAN_RE)) obsidian.push(m[1].trim());
  for (const m of body.matchAll(MD_BUNDLE_LINK_RE)) bundleLinks.push(m[1]);
  return { obsidian, bundleLinks, hasCitations: CITATIONS_RE.test(body) };
}
