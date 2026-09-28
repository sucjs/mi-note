/**
 * 小米笔记 —— 编辑器辅助（面板与侧边栏共用）。
 *
 * 目标是「日常写作手感」：Tab 缩进、列表自动续行、格式快捷键、工具栏动作。
 *
 * 两条重要约定：
 *   1. **所有改动都通过 textarea 的原生编辑能力完成**，并派发一次 input 事件。
 *      这样既保住了浏览器的原生撤销栈（Ctrl+Z 能一步步退回来），
 *      也让面板既有的「标脏 + 自动保存」逻辑自动生效 —— 不需要另接一套状态。
 *   2. 只处理 `\n`，不碰 `\r`：textarea 的 value 在浏览器里统一是 `\n`。
 */
(function () {
  "use strict";

  /** 行首列表标记：`- ` / `* ` / `+ ` / `1. `，可带任务框 */
  var LIST_RE = /^(\s*)([-*+]|\d+\.)(\s+)(\[[ xX]\]\s+)?/;
  /** 单个缩进宽度。用空格而非 Tab：Markdown 渲染对空格更宽容。 */
  var INDENT = "  ";

  /** 让面板的脏标记 / 自动保存逻辑感知这次改动。 */
  function notify(textarea) {
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /**
   * 以「整段替换」的方式改内容，并尽量保住光标位置。
   *
   * 必须用 execCommand('insertText')，不能用 setRangeText —— 实测（Chromium）：
   *   - setRangeText：不进原生撤销栈，用了它 Ctrl+Z 退不回来
   *   - insertText：替换选区 + 自动派发 input + **可撤销**
   * 用 `textarea.value = ...` 更糟：连撤销栈一起清空。
   * 编辑器辅助功能如果不能撤销，用户误按一下就没法回头，比没有还糟。
   */
  function replaceRange(textarea, start, end, text, selStart, selEnd) {
    textarea.focus();
    textarea.setSelectionRange(start, end);

    var applied = false;
    try {
      applied = document.execCommand("insertText", false, text);
    } catch (error) {
      applied = false;
    }
    if (!applied) {
      // 极端环境不支持时退回 setRangeText，并自己补一次 input（否则标脏/自动保存不触发）
      textarea.setRangeText(text, start, end, "end");
      notify(textarea);
    }
    // insertText 成功后浏览器已经派发过 input，这里不再重复派发

    if (typeof selStart === "number") {
      textarea.setSelectionRange(selStart, typeof selEnd === "number" ? selEnd : selStart);
    }
  }

  /** 当前行（含）在整篇文本里的起止偏移。 */
  function lineBounds(text, pos) {
    var start = text.lastIndexOf("\n", pos - 1) + 1;
    var end = text.indexOf("\n", pos);
    if (end === -1) end = text.length;
    return { start: start, end: end };
  }

  /**
   * 缩进 / 反缩进。
   *
   * 有选区时按整行逐行处理（编辑列表最常用的动作）；无选区时就是当前行。
   * 反缩进优先吃掉一整个缩进宽度，不足时退一个字符 —— 这样 Tab 之后
   * Shift+Tab 能精确还原，而手打的单个空格也能被清掉。
   *
   * @param {HTMLTextAreaElement} textarea
   * @param {boolean} outdent
   */
  function indent(textarea, outdent) {
    var text = textarea.value;
    var selStart = textarea.selectionStart;
    var selEnd = textarea.selectionEnd;

    var first = lineBounds(text, selStart);
    var last = lineBounds(text, selEnd);
    var blockStart = first.start;
    var blockEnd = last.end;
    /*
     * 有选区、且选区末尾正好落在某行行首时，那一行不该参与。
     * 判据必须同时要求「有选区」——否则光标停在行首（selStart === selEnd）时
     * 会把整块算成空，缩进什么都不做。
     */
    if (selEnd > selStart && selEnd === last.start && last.start > first.start) {
      blockEnd = last.start;
    }

    var block = text.slice(blockStart, blockEnd);
    var lines = block.split("\n");
    var firstDelta = 0;

    var changed = lines.map(function (line, index) {
      var delta = 0;
      if (outdent) {
        if (line.slice(0, INDENT.length) === INDENT) delta = -INDENT.length;
        else if (line[0] === " " || line[0] === "\t") delta = -1;
      } else {
        delta = INDENT.length;
      }
      if (index === 0) firstDelta = delta;
      if (delta < 0) return line.slice(-delta);
      if (delta > 0) return INDENT + line;
      return line;
    });

    var next = changed.join("\n");
    var caretStart = Math.max(blockStart, selStart + firstDelta);
    var caretEnd = Math.max(caretStart, selEnd + (next.length - block.length));
    replaceRange(textarea, blockStart, blockEnd, next, caretStart, caretEnd);
    return true;
  }

  /**
   * 回车时的列表续行。
   *
   * - 在列表项末尾回车 → 自动续上同样的标记（有序列表数字 +1）
   * - 在**空的**列表项上回车 → 去掉标记，退出列表（否则用户会被困在列表里）
   * - 不在列表里 → 交回浏览器默认行为
   *
   * @returns {boolean} 是否已处理
   */
  function continueList(textarea) {
    var text = textarea.value;
    var pos = textarea.selectionStart;
    if (pos !== textarea.selectionEnd) return false;

    var bounds = lineBounds(text, pos);
    var line = text.slice(bounds.start, bounds.end);
    var match = line.match(LIST_RE);
    if (!match) return false;

    var indentText = match[1];
    var marker = match[2];
    var spacing = match[3];
    var task = match[4] || "";
    var content = line.slice(match[0].length);

    // 空列表项：回车退出列表
    if (content.trim() === "") {
      replaceRange(textarea, bounds.start, bounds.end, "", bounds.start);
      return true;
    }

    // 光标在行中间时不该续行（用户是想在句子中间换行）
    if (pos < bounds.end) return false;

    var nextMarker = marker;
    var ordered = marker.match(/^(\d+)\.$/);
    if (ordered) nextMarker = String(Number(ordered[1]) + 1) + ".";
    // 任务列表续行后默认是「未完成」
    var nextTask = task ? "[ ] " : "";

    var insert = "\n" + indentText + nextMarker + spacing + nextTask;
    replaceRange(textarea, pos, pos, insert, pos + insert.length);
    return true;
  }

  /**
   * 包裹 / 取消包裹选区。
   *
   * 已包裹时会去掉标记，所以同一个快捷键可以来回切换，不必记「取消」的写法。
   * 空选区时插入一对标记并把光标放中间，方便直接输入。
   *
   * 「已包裹」有三种形态，缺一不可 —— 只认前两种的话，
   * 用户选中整段 `这是**重点**` 再按 Ctrl+B 会被又包一层，
   * 得到 `**这是**重点****` 这种废掉的内容：
   *   A. 选区在标记**内部**（`**|重点|**`）
   *   B. 选区**自带**标记（`|**重点**|`）
   *   C. 选区**包含**完整标记对（`|这是**重点**|`）
   */
  function wrap(textarea, before, after, placeholder) {
    after = after == null ? before : after;
    var text = textarea.value;
    var selStart = textarea.selectionStart;
    var selEnd = textarea.selectionEnd;
    var selected = text.slice(selStart, selEnd);

    // A. 选区正好在标记内部
    var outerBefore = text.slice(Math.max(0, selStart - before.length), selStart);
    var outerAfter = text.slice(selEnd, selEnd + after.length);
    if (outerBefore === before && outerAfter === after) {
      replaceRange(
        textarea,
        selStart - before.length,
        selEnd + after.length,
        selected,
        selStart - before.length,
        selStart - before.length + selected.length,
      );
      return;
    }

    // B. 选区自带标记
    if (selected.length >= before.length + after.length &&
        selected.slice(0, before.length) === before &&
        selected.slice(selected.length - after.length) === after) {
      var inner = selected.slice(before.length, selected.length - after.length);
      replaceRange(textarea, selStart, selEnd, inner, selStart, selStart + inner.length);
      return;
    }

    // C. 选区包含完整标记对（取第一个 before 与最后一个 after）
    var openAt = selected.indexOf(before);
    var closeAt = selected.lastIndexOf(after);
    if (openAt !== -1 && closeAt > openAt && closeAt + after.length <= selected.length) {
      var unwrapped =
        selected.slice(0, openAt) +
        selected.slice(openAt + before.length, closeAt) +
        selected.slice(closeAt + after.length);
      replaceRange(textarea, selStart, selEnd, unwrapped, selStart, selStart + unwrapped.length);
      return;
    }

    var body = selected || placeholder || "";
    var wrapped = before + body + after;
    replaceRange(
      textarea,
      selStart,
      selEnd,
      wrapped,
      selStart + before.length,
      selStart + before.length + body.length,
    );
  }

  /**
   * 给每行加 / 去行首标记（标题、引用、列表都走这个）。
   * 若所有行都已有该标记则视为「再点一次取消」。
   */
  function toggleLinePrefix(textarea, prefix, opts) {
    opts = opts || {};
    var text = textarea.value;
    var selStart = textarea.selectionStart;
    var selEnd = textarea.selectionEnd;
    var first = lineBounds(text, selStart);
    var last = lineBounds(text, selEnd);
    var blockStart = first.start;
    var blockEnd = last.end;
    var block = text.slice(blockStart, blockEnd);
    var lines = block.split("\n");

    var matcher = opts.match || new RegExp("^" + prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    var allHave = lines.every(function (l) { return l === "" || matcher.test(l); });

    var changed = lines.map(function (line) {
      if (line === "" && opts.skipEmpty !== false) return line;
      if (allHave) return line.replace(matcher, "");
      // 换标题级别：先把已有的标题标记去掉，避免 `## # 标题`
      var stripped = opts.exclusive ? line.replace(/^#{1,6}\s+/, "") : line;
      return prefix + stripped;
    });

    var next = changed.join("\n");
    var caretStart = Math.max(blockStart, selStart + (changed[0].length - lines[0].length));
    replaceRange(textarea, blockStart, blockEnd, next, caretStart, caretStart);
  }

  /** 在光标处插入一段文本（代码块、表格这类不需要选区的动作）。 */
  function insertBlock(textarea, text, caretOffset) {
    var pos = textarea.selectionStart;
    var selected = textarea.value.slice(pos, textarea.selectionEnd);
    // 选中了内容就包进块里，否则插入模板
    var body = selected ? text.replace("$SELECTION", selected) : text.replace("$SELECTION", "");
    replaceRange(textarea, pos, textarea.selectionEnd, body, pos + (caretOffset == null ? body.length : caretOffset));
  }

  /**
   * 插入图片语法，选中的文字作为**替代文字**，光标落在 URL 位置。
   *
   * 不能简单套用 wrap：那样会把选中的说明文字填进 URL 括号里，
   * 得到 `![图片说明](照片说明)` —— 替代文字丢了，URL 也成了中文。
   */
  function insertImage(textarea, placeholder) {
    var pos = textarea.selectionStart;
    var alt = textarea.value.slice(pos, textarea.selectionEnd) || placeholder || "图片说明";
    var snippet = "![" + alt + "](https://)";
    // 光标放到 `(https://` 之后、`)` 之前，方便直接粘地址
    var caret = pos + 2 + alt.length + 2;
    replaceRange(textarea, pos, textarea.selectionEnd, snippet, caret);
  }

  window.MiNoteEditor = {
    indent: indent,
    outdent: function (ta) { return indent(ta, true); },
    continueList: continueList,
    wrap: wrap,
    toggleLinePrefix: toggleLinePrefix,
    insertBlock: insertBlock,
    insertImage: insertImage,
    INDENT: INDENT,
  };
})();
