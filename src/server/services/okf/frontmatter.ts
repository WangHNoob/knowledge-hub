// src/server/services/okf/frontmatter.ts
// Dependency-free frontmatter splitter. Mirrors the regex idiom already used in
// src/server/services/kbBuilder/extractStage.ts (the project ships no YAML library).

export interface FrontmatterScan {
  hasFrontmatter: boolean;
  unparseable: boolean; // opened with --- but never closed
  body: string;
  keys: Set<string>; // top-level keys present in the block
  type: string; // trimmed, unquoted value of `type`; "" if absent/empty
}

const BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u;
const OPEN_RE = /^---\r?\n/u;
const SCALAR_RE = /^([A-Za-z_][\w-]*):\s*(.*)$/;

export function scanFrontmatter(markdown: string): FrontmatterScan {
  const match = BLOCK_RE.exec(markdown);
  if (!match) {
    return {
      hasFrontmatter: false,
      unparseable: OPEN_RE.test(markdown),
      body: markdown,
      keys: new Set(),
      type: "",
    };
  }

  const keys = new Set<string>();
  let type = "";
  for (const line of match[1].split(/\r?\n/)) {
    const scalar = SCALAR_RE.exec(line);
    if (!scalar) continue; // block child lines (indented) are skipped; parent key already captured
    const [, key, value] = scalar;
    keys.add(key);
    if (key === "type" && value.trim() !== "") {
      type = value.trim().replace(/^["']|["']$/gu, "");
    }
  }

  return { hasFrontmatter: true, unparseable: false, body: match[2], keys, type };
}
