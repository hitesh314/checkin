/**
 * Atlassian Document Format (ADF) -> readable plain text.
 *
 * ADF is the JSON document model Jira Cloud's v3 API uses for rich text. We
 * only need enough fidelity for a model to understand a ticket, so formatting
 * marks such as bold and italic are dropped, while structure that carries
 * meaning (headings, lists, task state, code, links, tables) is preserved.
 * Unknown node types degrade to their text content instead of failing.
 */

interface AdfMark {
  type?: string;
  attrs?: Record<string, unknown>;
}

interface AdfNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
  content?: AdfNode[];
}

const MAX_DEPTH = 40;

function isNode(value: unknown): value is AdfNode {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function children(node: AdfNode): AdfNode[] {
  return Array.isArray(node.content) ? node.content.filter(isNode) : [];
}

function inlineText(nodes: AdfNode[], depth: number): string {
  return nodes.map((n) => inlineNode(n, depth)).join("");
}

function inlineNode(node: AdfNode, depth: number): string {
  if (depth > MAX_DEPTH) return "";
  switch (node.type) {
    case "text": {
      let text = node.text ?? "";
      const marks = node.marks ?? [];
      if (marks.some((m) => m.type === "code") && text !== "") text = `\`${text}\``;
      const href = str(marks.find((m) => m.type === "link")?.attrs?.href);
      if (href !== undefined && href !== text) text = `${text} (${href})`;
      return text;
    }
    case "hardBreak":
      return "\n";
    case "mention":
      return str(node.attrs?.text) ?? "@someone";
    case "emoji":
      return str(node.attrs?.text) ?? str(node.attrs?.shortName) ?? "";
    case "inlineCard":
      return str(node.attrs?.url) ?? "[link]";
    case "status":
      return `[${str(node.attrs?.text) ?? "status"}]`;
    case "date": {
      const ts = Number(node.attrs?.timestamp);
      return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : "";
    }
    case "media":
    case "mediaInline":
      return "[attachment]";
    default:
      return inlineText(children(node), depth + 1);
  }
}

function indentContinuation(text: string, prefix: string): string {
  const pad = " ".repeat(prefix.length);
  return text
    .split("\n")
    .map((line, i) => (i === 0 ? `${prefix}${line}` : line === "" ? line : `${pad}${line}`))
    .join("\n");
}

function blocks(nodes: AdfNode[], depth: number): string {
  return nodes
    .map((n) => block(n, depth))
    .filter((s) => s !== "")
    .join("\n\n");
}

function listItems(node: AdfNode, depth: number, marker: (i: number, item: AdfNode) => string): string {
  return children(node)
    .map((item, i) => indentContinuation(blocks(children(item), depth + 1).replace(/\n\n/g, "\n"), marker(i, item)))
    .join("\n");
}

function block(node: AdfNode, depth: number): string {
  if (depth > MAX_DEPTH) return "[…nested too deeply…]";
  switch (node.type) {
    case "paragraph":
      return inlineText(children(node), depth + 1).trim();
    case "heading": {
      const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 6);
      return `${"#".repeat(level)} ${inlineText(children(node), depth + 1).trim()}`;
    }
    case "bulletList":
      return listItems(node, depth, () => "- ");
    case "orderedList": {
      const start = Number(node.attrs?.order) || 1;
      return listItems(node, depth, (i) => `${start + i}. `);
    }
    case "taskList":
      return listItems(node, depth, (_i, item) => (item.attrs?.state === "DONE" ? "- [x] " : "- [ ] "));
    case "codeBlock": {
      const lang = str(node.attrs?.language) ?? "";
      return `\`\`\`${lang}\n${children(node).map((n) => n.text ?? "").join("")}\n\`\`\``;
    }
    case "blockquote":
      return blocks(children(node), depth + 1)
        .split("\n")
        .map((l) => `> ${l}`.trimEnd())
        .join("\n");
    case "rule":
      return "---";
    case "table":
      return children(node)
        .map((row) =>
          children(row)
            .map((cell) => blocks(children(cell), depth + 2).replace(/\s*\n+\s*/g, " "))
            .join(" | "),
        )
        .join("\n");
    case "panel":
      return `[${str(node.attrs?.panelType) ?? "note"}] ${blocks(children(node), depth + 1)}`;
    case "expand":
    case "nestedExpand": {
      const title = str(node.attrs?.title);
      const inner = blocks(children(node), depth + 1);
      return title !== undefined ? `${title}\n${inner}` : inner;
    }
    case "mediaSingle":
    case "mediaGroup":
      return children(node).length > 0 ? children(node).map(() => "[attachment]").join(" ") : "";
    case "blockCard":
      return str(node.attrs?.url) ?? "[link]";
    case "decisionList":
      return listItems(node, depth, () => "- Decision: ");
    case "text":
    case "hardBreak":
    case "mention":
    case "emoji":
    case "inlineCard":
    case "status":
    case "date":
      return inlineNode(node, depth + 1);
    default: {
      // Unknown container: keep whatever readable content it has.
      const kids = children(node);
      if (kids.length === 0) return node.text ?? "";
      return kids.some((k) => isBlockType(k.type)) ? blocks(kids, depth + 1) : inlineText(kids, depth + 1).trim();
    }
  }
}

const BLOCK_TYPES = new Set([
  "paragraph", "heading", "bulletList", "orderedList", "taskList", "codeBlock", "blockquote", "rule",
  "table", "panel", "expand", "nestedExpand", "mediaSingle", "mediaGroup", "blockCard", "decisionList",
]);

function isBlockType(type: string | undefined): boolean {
  return type !== undefined && BLOCK_TYPES.has(type);
}

/** Convert an ADF document (or a plain string, as the v2 API returns) to readable text. */
export function adfToText(doc: unknown): string {
  if (doc === null || doc === undefined) return "";
  if (typeof doc === "string") return doc.trim();
  if (!isNode(doc)) return "";
  const text = doc.type === "doc" ? blocks(children(doc), 0) : block(doc, 0);
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
