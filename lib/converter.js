"use strict";

/**
 * 小米云笔记内容格式 ↔ Markdown。
 *
 * 小米笔记的 content 字段是自有的类 XML 标记（不是 HTML，也不是纯文本），每行一个
 * 块级标签：<text indent="N">…</text>、<bullet indent="N" />…、<order … />…、
 * <input type="checkbox" …/>…、<quote>…</quote>、<hr />，行内用 <b>/<i>/<delete>/<u>。
 *
 * 本模块负责双向转换：
 *   - xmlToMarkdown：读（面板正文、AI 问答、导出）
 *   - markdownToXml：写（新建、编辑保存）
 */

// ── 行内样式 ────────────────────────────────────────────────────────────────

const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(value) {
  return String(value ?? "").replace(/&([a-z]+);/gi, (_m, name) => {
    const hit = HTML_ENTITIES[String(name).toLowerCase()];
    return hit ?? `&${name};`;
  });
}

function escapeXml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 小米的 <background color> 是 BGR 序，转成 CSS 用的 RGB。 */
function bgrToRgb(bgr) {
  const hex = String(bgr ?? "").replace("#", "");
  if (hex.length < 6) return bgr;
  return `#${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}`;
}

const HEADING_TAGS = [
  { tag: "size", prefix: "#" },
  { tag: "mid-size", prefix: "##" },
  { tag: "h3-size", prefix: "###" },
];

function inlineXmlToMd(text) {
  if (!text) return "";
  let out = text;
  out = out.replace(/<b>([\s\S]*?)<\/b>/g, "**$1**");
  out = out.replace(/<i>([\s\S]*?)<\/i>/g, "*$1*");
  out = out.replace(/<delete>([\s\S]*?)<\/delete>/g, "~~$1~~");
  out = out.replace(/<u>([\s\S]*?)<\/u>/g, "<u>$1</u>");
  out = out.replace(
    /<background\s+color="([^"]+)">([\s\S]*?)<\/background>/g,
    (_m, color, inner) => `<mark style="background:${bgrToRgb(color)}">${inner}</mark>`,
  );
  for (const { tag } of HEADING_TAGS) {
    out = out.replace(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"), "**$1**");
  }
  // 残留的未知标签（如 <0/>、<new-format/>）直接丢弃
  out = out.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  return decodeEntities(out);
}

/** 行内 Markdown → 小米 XML 行内标记。 */
function inlineMdToXml(text) {
  const underlines = [];
  const OPEN = "\uE000";
  const CLOSE = "\uE001";
  let stage = String(text ?? "").replace(/<u>([\s\S]*?)<\/u>/g, (_m, inner) => {
    underlines.push(inner);
    return `${OPEN}${underlines.length - 1}${CLOSE}`;
  });
  stage = escapeXml(stage);
  stage = stage.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  stage = stage.replace(/(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)/g, "<i>$1</i>");
  stage = stage.replace(/~~(.+?)~~/g, "<delete>$1</delete>");
  stage = stage.replace(
    new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g"),
    (_m, idx) => `<u>${escapeXml(underlines[Number(idx)])}</u>`,
  );
  return stage;
}

// ── XML → Markdown ─────────────────────────────────────────────────────────

/** indent 属性是 1 基，Markdown 用 0 基。 */
function indentLevel(raw) {
  const n = Number(raw || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, n - 1);
}

const LIST_TYPES = new Set(["checkbox", "bullet", "order"]);
const BLOCK_TYPES = new Set(["heading", "hr", "quote"]);

function needsBlankLine(prev, curr) {
  if (!prev) return false;
  if (prev === curr && LIST_TYPES.has(curr)) return false;
  if (prev === "text" && curr === "text") return true;
  if (BLOCK_TYPES.has(curr) || BLOCK_TYPES.has(prev)) return true;
  if (LIST_TYPES.has(prev) !== LIST_TYPES.has(curr)) return true;
  return false;
}

function parseXmlLine(line, orderCounters) {
  if (!line) return { type: "blank", text: "" };

  // order 必须最先判断：它是唯一读写序号计数器的分支
  const orderMatch = line.match(
    /^<order\s+indent="(\d+)"(?:\s+inputNumber="(\d+)")?\s*\/>(.*)$/,
  );
  if (orderMatch) {
    const indent = indentLevel(orderMatch[1]);
    const explicit = orderMatch[2] ? Number(orderMatch[2]) : 0;
    for (const key of [...orderCounters.keys()]) {
      if (key > indent) orderCounters.delete(key);
    }
    const number = explicit > 0 ? explicit : (orderCounters.get(indent) ?? 0) + 1;
    orderCounters.set(indent, number);
    return {
      type: "order",
      text: `${"  ".repeat(indent)}${number}. ${inlineXmlToMd(orderMatch[3].trim())}`,
    };
  }

  orderCounters.clear();

  if (/^<hr\s*\/>$/.test(line)) return { type: "hr", text: "---" };

  const checkboxMatch = line.match(/^<input\s+([^>]*?)type="checkbox"([^>]*?)\s*\/>(.*)$/);
  if (checkboxMatch) {
    const attrs = `${checkboxMatch[1]}${checkboxMatch[2]}`;
    const indent = indentLevel((attrs.match(/indent="(\d+)"/) ?? [])[1]);
    const checked = (attrs.match(/checked="(true|false)"/) ?? [])[1] === "true";
    const body = inlineXmlToMd(checkboxMatch[3].replace(/<0\/>/g, "").trim());
    return {
      type: "checkbox",
      text: `${"  ".repeat(indent)}- [${checked ? "x" : " "}] ${body}`,
    };
  }

  const bulletMatch = line.match(/^<bullet\s+indent="(\d+)"\s*\/>(.*)$/);
  if (bulletMatch) {
    return {
      type: "bullet",
      text: `${"  ".repeat(indentLevel(bulletMatch[1]))}- ${inlineXmlToMd(bulletMatch[2].trim())}`,
    };
  }
  const bulletWrapped = line.match(/^<bullet(?:\s+indent="(\d+)")?\s*>([\s\S]*?)<\/bullet>$/);
  if (bulletWrapped) {
    return {
      type: "bullet",
      text: `${"  ".repeat(indentLevel(bulletWrapped[1]))}- ${inlineXmlToMd(bulletWrapped[2].trim())}`,
    };
  }

  const quoteMatch = line.match(/^<quote>([\s\S]*?)<\/quote>$/);
  if (quoteMatch) {
    const inner = quoteMatch[1].replace(/\u2028/g, "\n");
    const parts = [...inner.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) => m[1].trim());
    const lines = parts.length ? parts : [inner.trim()];
    return {
      type: "quote",
      text: lines.map((l) => `> ${inlineXmlToMd(l)}`).join("\n"),
    };
  }

  const textMatch = line.match(/^<text(?:\s+indent="(\d+)")?\s*>([\s\S]*?)<\/text>$/);
  if (textMatch) {
    const inner = textMatch[2];
    if (!inner.trim() || textMatch[1] === "NaN") return { type: "blank", text: "" };
    const trimmed = inner.trim();
    for (const { tag, prefix } of HEADING_TAGS) {
      const m = trimmed.match(new RegExp(`^<${tag}>([\\s\\S]*?)</${tag}>$`));
      if (m) return { type: "heading", text: `${prefix} ${inlineXmlToMd(m[1].trim())}` };
    }
    return {
      type: "text",
      text: `${"  ".repeat(indentLevel(textMatch[1]))}${inlineXmlToMd(trimmed)}`,
    };
  }

  const alignMatch = line.match(/^<align\s+align="(center|left|right)">([\s\S]*?)<\/align>$/);
  if (alignMatch) {
    return {
      type: "text",
      text: `<div align="${alignMatch[1]}">${inlineXmlToMd(alignMatch[2].trim())}</div>`,
    };
  }

  if (/^☺\s/.test(line)) return null;

  const cleaned = inlineXmlToMd(line).trim();
  return cleaned ? { type: "text", text: cleaned } : null;
}

/**
 * 小米 XML 内容 → Markdown 文本。
 * @param {string} content
 * @param {object} [options]
 * @param {Array<{rawId:string,fileId:string,mimeType:string,name?:string}>} [options.files]
 *        附件列表，用于把 <img fileid=…/> 之类的占位符替换成可读标记
 * @param {boolean} [options.withAttachmentPlaceholders] 是否保留附件占位行（默认 true）
 */
function xmlToMarkdown(content, options = {}) {
  if (!content) return "";
  const { files = [], withAttachmentPlaceholders = true } = options;
  let text = String(content).replace(/\r\n/g, "\n");

  if (withAttachmentPlaceholders && files.length) {
    text = replaceAttachments(text, files);
  }

  text = text.replace(/<new-format\s*\/>/g, "").replace(/<0\/>/g, "");
  // 多行 quote 内部换行先换成占位符，让整块在逐行解析时作为一行处理
  text = text.replace(/<quote>([\s\S]*?)<\/quote>/g, (_m, inner) =>
    `<quote>${inner.replace(/\n/g, "\u2028")}</quote>`,
  );

  const out = [];
  const counters = new Map();
  let prevType = "";
  for (const rawLine of text.split("\n")) {
    const parsed = parseXmlLine(rawLine.trim(), counters);
    if (parsed === null) {
      counters.clear();
      continue;
    }
    if (out.length && needsBlankLine(prevType, parsed.type)) out.push("");
    out.push(parsed.text);
    prevType = parsed.type;
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function replaceAttachments(content, files) {
  let out = content;
  for (const file of files) {
    const id = file.fileId || file.rawId || "";
    if (!id) continue;
    const label = file.name || id.slice(-8);
    const escaped = String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mime = String(file.mimeType || "");
    const kind = mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : "img";
    const replacement =
      kind === "audio" ? `[🔊 ${label}](mi-note://audio/${id})`
        : kind === "video" ? `[🎬 ${label}](mi-note://video/${id})`
          : `![${label}](mi-note://image/${id})`;
    for (const tag of ["img", "sound", "video"]) {
      const re = new RegExp(
        `<${tag}\\s+[^>]*(?:id|fileid|data)="[^"]*${escaped}[^"]*"[^>]*/>`,
        "g",
      );
      out = out.replace(re, replacement);
    }
    out = out.replace(new RegExp(`☺\\s*${escaped}(?!<)`, "g"), replacement);
  }
  return out;
}

// ── Markdown → XML ─────────────────────────────────────────────────────────

/**
 * Markdown → 小米 XML 内容。
 *
 * 列表用「栈式相对缩进」推断层级：Markdown 里 2/3/4 空格与 tab 混用很常见，按宽度
 * 增减推层级比规范解析更耐用。
 */
function markdownToXml(markdown) {
  if (!markdown) return "";
  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  const out = [];

  // 先把连续引用行合并成 quote 块
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^>\s?(.*)$/);
    if (!m) {
      blocks.push({ kind: "line", line: lines[i] });
      continue;
    }
    const quoted = [m[1]];
    while (i + 1 < lines.length) {
      const next = lines[i + 1].match(/^>\s?(.*)$/);
      if (!next) break;
      quoted.push(next[1]);
      i += 1;
    }
    blocks.push({ kind: "quote", lines: quoted });
  }

  const stack = [];
  const resetStack = () => {
    stack.length = 0;
  };
  const leadingWidth = (leading) => {
    let w = 0;
    for (const ch of leading) {
      if (ch === "\t") w += 4;
      else if (ch === " ") w += 1;
      else break;
    }
    return w;
  };
  const listLevel = (leading) => {
    const width = leadingWidth(leading);
    while (stack.length && stack[stack.length - 1].width > width) stack.pop();
    const top = stack[stack.length - 1];
    if (top && top.width === width) return top.level;
    const level = stack.length === 0 ? 1 : top.level + 1;
    stack.push({ width, level });
    return level;
  };

  for (const block of blocks) {
    if (block.kind === "quote") {
      const inner = block.lines
        .map((l) => `<text indent="1">${inlineMdToXml(l)}</text>`)
        .join("\n");
      out.push(`<quote>${inner}</quote>`);
      resetStack();
      continue;
    }

    const line = block.line.replace(/\s+$/, "");

    // 附件既可能是图片语法 ![名](mi-note://image/id)，也可能是链接语法（音视频）
    const attachment = line.match(/!?\[[^\]]*\]\((mi-note:\/\/[^)]+)\)/);
    if (attachment) {
      const fileId = resolveAttachmentId(attachment[1]);
      if (fileId) {
        const tag = attachment[1].startsWith("mi-note://audio/") ? "sound"
          : attachment[1].startsWith("mi-note://video/") ? "video"
            : "img";
        out.push(`<${tag} fileid="${escapeXml(fileId)}" imgshow="0" imgdes="" />`);
        resetStack();
        continue;
      }
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const tag = heading[1].length === 1 ? "size" : heading[1].length === 2 ? "mid-size" : "h3-size";
      out.push(`<text indent="1"><${tag}>${escapeXml(heading[2])}</${tag}></text>`);
      resetStack();
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      out.push("<hr />");
      resetStack();
      continue;
    }

    const checkbox = line.match(/^(\s*)[-*]\s+\[([xX ])\]\s+(.*)$/);
    if (checkbox) {
      const indent = listLevel(checkbox[1]);
      const checked = checkbox[2].toLowerCase() === "x" ? ' checked="true"' : "";
      out.push(
        `<input type="checkbox" indent="${indent}" level="3"${checked} />${inlineMdToXml(checkbox[3])}`,
      );
      continue;
    }

    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) {
      out.push(`<bullet indent="${listLevel(bullet[1])}" />${inlineMdToXml(bullet[2])}`);
      continue;
    }

    const order = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (order) {
      out.push(
        `<order indent="${listLevel(order[1])}" inputNumber="${order[2]}" />${inlineMdToXml(order[3])}`,
      );
      continue;
    }

    if (!line.trim()) {
      out.push('<text indent="1"></text>');
      continue;
    }

    const indent = line.startsWith("\t") ? 2 : 1;
    out.push(`<text indent="${indent}">${inlineMdToXml(line.replace(/^\t/, ""))}</text>`);
    resetStack();
  }

  return out.join("\n");
}

function resolveAttachmentId(target) {
  const match = String(target).match(/^mi-note:\/\/(?:image|audio|video)\/(.+)$/);
  return match ? match[1] : null;
}

/** 取 XML 内容里的首行非空文本，作为列表摘要（小米的 snippet 字段）。 */
function extractSnippet(xml) {
  return (
    String(xml || "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ""
  );
}

/** 把 Markdown 压成一行纯文本摘要。 */
function summarize(markdown, maxLength = 120) {
  const flat = String(markdown || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~`>#-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength)}…` : flat;
}

/** 从 Markdown 取标题（首个 H1，其次首个非空行）。 */
function titleFromMarkdown(markdown) {
  const lines = String(markdown || "").split("\n");
  for (const line of lines) {
    const m = line.match(/^#\s+(.+)$/);
    if (m) return m[1].trim();
  }
  for (const line of lines) {
    const t = line.trim();
    if (t) return summarize(t, 60);
  }
  return "";
}

module.exports = {
  extractSnippet,
  inlineMdToXml,
  inlineXmlToMd,
  markdownToXml,
  summarize,
  titleFromMarkdown,
  xmlToMarkdown,
};
