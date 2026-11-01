// Renders page/doc.md into page/index.html.
//
// The Magpie page runs in a sandbox iframe with `connect-src 'none'`, so the
// output must be self-contained apart from its own stylesheet: no markdown
// runtime, no network requests, no client JavaScript of its own. It must load
// Magpie's bridge (`_magpie/bridge.js`), which says hello to the window — a
// page that never says hello is replaced by "This page stopped working" after
// 10 seconds. The bridge only paints the theme; the page stays static.
// This is a deliberately small Markdown subset (headings, paragraphs, lists,
// code fences, tables, blockquotes, links, bold, inline code).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const sourcePath = join(root, "page", "doc.md");
const outputPath = join(root, "page", "index.html");

// Magpie names a plugin's tools by its package's short name: no scope, and no
// middleware-/opencode-/tools-/page-/agent- prefix. The same name ends the
// per-plugin MCP address, so both are derived from package.json rather than
// repeated here where they drift.
const packageJson = JSON.parse(readFileSync(join(root, "..", "package.json"), "utf8")) as { name?: unknown };
const packageName = typeof packageJson.name === "string" ? packageJson.name : "";
const shortName = packageName
  .replace(/^@[^/]+\//, "")
  .replace(/^(middleware-|opencode-|tools-|page-|agent-)/, "")
  .replace(/-auth$/, "");
if (!shortName) throw new Error("package.json needs a name for the plugin's MCP prefix");
const TOOL_PREFIX = shortName;

const REQUIRED_TOOLS = [
  "status",
  "wallet",
  "wallet_import",
  "wallet_export",
  "join_network",
  "network_daemon",
  "native_models",
  "share_models",
  "discover",
  "request_access",
  "connect_provider",
  "disconnect_provider",
  "connections",
  "consumers",
  "approve_request",
  "reject_request",
  "revoke_consumer",
  "send_payment",
  "history",
  "contacts",
];
const REQUIRED_URL = "http://127.0.0.1:3425/mcp/magpie/tools";
const REQUIRED_PLUGIN_URL = `${REQUIRED_URL}/${TOOL_PREFIX}`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inline(value: string): string {
  const codeSpans: string[] = [];
  let text = value.replace(/`([^`]+)`/g, (_match, code: string) => {
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });

  text = escapeHtml(text);

  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, url: string) => {
    if (!/^(https?:\/\/|#)/.test(url)) return match;
    return `<a href="${url.replace(/&amp;/g, "&")}" rel="noreferrer">${label}</a>`;
  });
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => codeSpans[Number(index)] ?? "");
  return text;
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return body.includes("-") && /^[\s:|-]+$/.test(body);
}

function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: "ul" | "ol" | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!list) return;
    out.push(`</${list}>`);
    list = null;
  };
  const flush = () => {
    flushParagraph();
    closeList();
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      flush();
      const language = line.trim().slice(3).trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) i += 1;
      const cls = /^[A-Za-z0-9_-]+$/.test(language) ? ` class="language-${language}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      flush();
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    if (line.trim() === "---" || line.trim() === "***") {
      flush();
      out.push("<hr>");
      i += 1;
      continue;
    }

    if (line.trimStart().startsWith("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flush();
      const headers = tableCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        rows.push(tableCells(lines[i]));
        i += 1;
      }
      const head = headers.map((cell) => `<th>${inline(cell)}</th>`).join("");
      const body = rows
        .map((cells) => `<tr>${headers.map((_header, at) => `<td>${inline(cells[at] ?? "")}</td>`).join("")}</tr>`)
        .join("");
      out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
      continue;
    }

    if (line.trimStart().startsWith(">")) {
      flush();
      const quote: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith(">")) {
        quote.push(lines[i].trimStart().replace(/^>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote><p>${inline(quote.join(" "))}</p></blockquote>`);
      continue;
    }

    const unordered = /^\s*[-*]\s+(.*)$/.exec(line);
    if (unordered) {
      flushParagraph();
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${inline(unordered[1])}</li>`);
      i += 1;
      continue;
    }

    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      flushParagraph();
      if (list !== "ol") {
        closeList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${inline(ordered[1])}</li>`);
      i += 1;
      continue;
    }

    closeList();
    paragraph.push(line.trim());
    i += 1;
  }

  flush();
  return out.join("\n");
}

function page(markdown: string): string {
  const body = renderMarkdown(markdown);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Oh My AIHub</title>
<link rel="stylesheet" href="./style.css">
<script src="_magpie/bridge.js"></script>
</head>
<body>
<main class="doc">
${body}
</main>
</body>
</html>
`;
}

const markdown = readFileSync(sourcePath, "utf8");
for (const tool of REQUIRED_TOOLS) {
  const name = `${TOOL_PREFIX}_${tool}`;
  if (!markdown.includes(name)) throw new Error(`page/doc.md does not mention ${name}`);
}
if (!markdown.includes(REQUIRED_URL)) throw new Error(`page/doc.md does not mention ${REQUIRED_URL}`);
if (!markdown.includes(REQUIRED_PLUGIN_URL)) throw new Error(`page/doc.md does not mention ${REQUIRED_PLUGIN_URL}`);

const html = page(markdown);
// Magpie's window replaces a page that never says hello with "This page
// stopped working" after ten seconds; the bridge is what says it.
if (!html.includes('src="_magpie/bridge.js"')) {
  throw new Error("the page lost Magpie's bridge script; the window would show it as broken");
}
writeFileSync(outputPath, html, { mode: 0o644 });
console.log(`wrote ${outputPath} (${Buffer.byteLength(html)} bytes, ${REQUIRED_TOOLS.length} tools documented)`);
