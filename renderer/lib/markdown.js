/**
 * 小米笔记 —— Markdown 渲染模块（面板与侧边栏共用的唯一实现）。
 *
 * 为什么单独一个文件：
 *   此前面板（renderer/index.html）与侧边栏（views/sidebar.html）各有一份**逐字相同**
 *   的 renderMarkdown，任何语法补强都要改两处，漏一处两侧就不一致。现在只有这一份。
 *
 * 为什么用全局变量而不是 ES module：
 *   宿主以 file:// 协议加载面板，`<script type="module">` 会被 Chromium 的 CORS 策略
 *   拒绝。所以所有产物都必须是经典脚本（IIFE），挂到 window 上。
 *
 * 依赖（都在同目录 vendor/ 下，随包离线加载）：
 *   - markdown-it         Markdown 解析与渲染
 *   - markdown-it-task-lists  任务列表
 *   - highlight.js        代码块语法高亮（可选，缺失时降级为纯文本）
 *   - KaTeX               数学公式（可选，缺失时保留原文）
 *
 * 用法：
 *   const html = window.MiNoteMarkdown.render(markdown);
 *   window.MiNoteMarkdown.highlightInto(container);  // 填充图片等异步内容
 */
(function () {
  "use strict";

  var md = null;
  var katex = typeof window !== "undefined" ? window.katex : null;

  /** KaTeX 的 CSS 类名带 katex，用它判断公式是否真的渲染成功。 */
  function renderMath(tex, displayMode) {
    if (!katex || !katex.renderToString) return null;
    try {
      return katex.renderToString(tex, {
        displayMode: displayMode,
        throwOnError: false,
        strict: false,
        // 输出 HTML 而非 MathML：面板是 Chromium，不需要 MathML 兜底，
        // 省掉一半体积。KaTeX 仍会带上 MathML 供无障碍，故这里不关。
      });
    } catch (error) {
      return null;
    }
  }

  /**
   * 数学公式规则。
   *
   * 自己写而不是引第三方插件：插件没有 UMD 产物，而面板必须是经典脚本。
   * 规则尽量保守，避免误伤普通文本：
   *   - 行内 `$…$`：左界不能是反斜杠或数字，右界不能是空白（防 `$5 和 $10` 被吃掉）
   *   - 块级 `$$…$$`：优先于行内匹配
   */
  function mathPlugin(instance) {
    // 块级 $$…$$
    instance.block.ruler.before("fence", "math_block", function (state, startLine, endLine, silent) {
      var start = state.bMarks[startLine] + state.tShift[startLine];
      var max = state.eMarks[startLine];
      var line = state.src.slice(start, max);

      if (!/^\$\$/.test(line)) return false;
      if (silent) return true;

      // 单行 $$…$$
      var single = line.match(/^\$\$(.+?)\$\$\s*$/);
      if (single) {
        var token = state.push("math_block", "math", 0);
        token.content = single[1].trim();
        token.map = [startLine, startLine + 1];
        state.line = startLine + 1;
        return true;
      }

      // 多行：找收尾的 $$
      var nextLine = startLine + 1;
      var body = [line.slice(2)];
      for (; nextLine < endLine; nextLine += 1) {
        var s = state.bMarks[nextLine] + state.tShift[nextLine];
        var e = state.eMarks[nextLine];
        var cur = state.src.slice(s, e);
        var close = cur.indexOf("$$");
        if (close >= 0) {
          body.push(cur.slice(0, close));
          nextLine += 1;
          break;
        }
        body.push(cur);
      }
      var tok = state.push("math_block", "math", 0);
      tok.content = body.join("\n").trim();
      tok.map = [startLine, nextLine];
      state.line = nextLine;
      return true;
    });

    instance.renderer.rules.math_block = function (tokens, idx) {
      var html = renderMath(tokens[idx].content, true);
      if (html) return '<div class="katex-block">' + html + "</div>\n";
      // KaTeX 不可用：原样显示，至少不丢内容
      return '<pre class="katex-fallback">$$' + escapeHtml(tokens[idx].content) + "$$</pre>\n";
    };

    // 行内 $…$
    instance.inline.ruler.before("escape", "math_inline", function (state, silent) {
      var src = state.src;
      var pos = state.pos;
      if (src[pos] !== "$") return false;
      // 左界保护：反斜杠转义、数字后接 $（如「价格 5$」）都不当公式
      var prev = pos > 0 ? src[pos - 1] : "";
      if (prev === "\\") return false;
      if (/[0-9]/.test(prev)) return false;
      if (src[pos + 1] === "$") return false; // 交给块级规则

      var end = pos + 1;
      while (end < src.length) {
        if (src[end] === "$" && src[end - 1] !== "\\") break;
        if (src[end] === "\n") return false; // 行内公式不跨行
        end += 1;
      }
      if (end >= src.length || src[end] !== "$") return false;
      var content = src.slice(pos + 1, end);
      if (!content.trim()) return false;
      // 右界保护：内容末尾是空白说明更像普通文本
      if (/\s$/.test(content)) return false;
      if (silent) return true;

      var token = state.push("math_inline", "math", 0);
      token.content = content;
      state.pos = end + 1;
      return true;
    });

    instance.renderer.rules.math_inline = function (tokens, idx) {
      var html = renderMath(tokens[idx].content, false);
      if (html) return html;
      return '<code class="katex-fallback">$' + escapeHtml(tokens[idx].content) + "$</code>";
    };
  }

  /**
   * 附件图片规则：把 `![名](mi-note://image/<id>)` 渲染成占位 <img>。
   *
   * 关键约束：**不改动 Markdown 源码形态**。图片二进制由面板异步经
   * mn.attachment.get 取回后填进 src，这里只产出带 data-file-id 的骨架。
   * 若渲染成别的形态，编辑保存时 lib/converter.js 的写回就认不出附件了。
   */
  function attachmentRule(instance) {
    var defaultImage = instance.renderer.rules.image;
    instance.renderer.rules.image = function (tokens, idx, options, env, self) {
      var token = tokens[idx];
      var src = token.attrGet("src") || "";
      var match = src.match(/^mi-note:\/\/(image|audio|video)\/(.+)$/);
      if (!match) return defaultImage(tokens, idx, options, env, self);

      var kind = match[1];
      var fileId = match[2];
      var label = token.content || "";
      if (kind !== "image") {
        // 音频/视频本次不做内联播放，保留为可点击的文本链接
        var icon = kind === "audio" ? "🔊" : "🎬";
        return '<a class="attachment-link" href="#" data-attachment-kind="' + kind +
          '" data-file-id="' + escapeAttr(fileId) + '">' + icon + " " + escapeHtml(label) + "</a>";
      }
      return '<img class="md-attachment" data-file-id="' + escapeAttr(fileId) +
        '" alt="' + escapeAttr(label) + '" src="" />';
    };
  }

  /**
   * 放行转换层产出的少数安全 HTML 标签。
   *
   * lib/converter.js 会把小米的下划线转成 <u>、背景色转成
   * <mark style="background:#rrggbb">。这两者若走 markdown-it 的 html:true 就等于
   * 对整个文档开放 HTML 透传（XSS 风险），所以改为：保持 html:false，
   * 渲染后用极窄的白名单把转义后的标签还原回来。
   */
  var ALLOWED_INLINE = [
    // <u>…</u>
    { re: /&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/g, out: "<u>$1</u>" },
    // <mark style="background:#rrggbb">…</mark>（只放行 #hex，挡掉 url()/expression）
    {
      re: /&lt;mark style=&quot;background:(#[0-9a-fA-F]{3,8})&quot;&gt;([\s\S]*?)&lt;\/mark&gt;/g,
      out: '<mark style="background:$1">$2</mark>',
    },
  ];

  function restoreAllowedTags(html) {
    var out = html;
    for (var i = 0; i < ALLOWED_INLINE.length; i += 1) {
      var rule = ALLOWED_INLINE[i];
      // 反复替换直到稳定：内容里可能还嵌着同类标签
      for (var guard = 0; guard < 5 && rule.re.test(out); guard += 1) {
        rule.re.lastIndex = 0;
        out = out.replace(rule.re, rule.out);
      }
      rule.re.lastIndex = 0;
    }
    return out;
  }

  function escapeHtml(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(text) {
    return escapeHtml(text);
  }

  /**
   * 给高亮过的代码块补上 hljs 基类。
   *
   * highlight.js 的主题 CSS 依赖 `.hljs` 这个基类来设 color / background / padding。
   * 只返回高亮片段是不够的 —— 少了基类，主题只会给 span 上色，
   * 代码块本身的文字颜色仍是面板默认色，在深色主题下几乎看不清。
   *
   * 这里用 fence 规则统一包一层，而不是在 highlight 回调里返回带 class 的
   * `<pre><code>`：回调的返回值会被 markdown-it 再包一次 pre/code，会重复。
   */
  function highlightClassRule(instance) {
    var defaultFence = instance.renderer.rules.fence;
    instance.renderer.rules.fence = function (tokens, idx, options, env, self) {
      var html = defaultFence(tokens, idx, options, env, self);
      // 只有真正高亮出 span 的块才需要（未高亮时 markdown-it 输出的是纯文本）
      if (html.indexOf("<span class=\"hljs-") === -1) return html;
      return html.replace("<code", '<code class="hljs"');
    };
  }

  /** 链接一律新窗口打开，并补 rel 防 window.opener 泄漏。 */
  function linkRule(instance) {    var defaultLinkOpen =
      instance.renderer.rules.link_open ||
      function (tokens, idx, options, env, self) {
        return self.renderToken(tokens, idx, options);
      };
    instance.renderer.rules.link_open = function (tokens, idx, options, env, self) {
      var token = tokens[idx];
      var href = token.attrGet("href") || "";
      // 只放行安全协议；其余（javascript: / data: / file:）降级为不可点
      if (!/^(https?:|mailto:|mi-note:)/i.test(href)) {
        token.attrSet("href", "#");
        token.attrSet("data-blocked-href", href);
      } else {
        token.attrSet("target", "_blank");
        token.attrSet("rel", "noreferrer noopener");
      }
      return defaultLinkOpen(tokens, idx, options, env, self);
    };
  }

  function ensureInstance() {
    if (md) return md;
    if (typeof window.markdownit !== "function") {
      // 库没加载上：返回 null，render() 会走纯文本兜底
      return null;
    }
    md = window.markdownit({
      // html 必须保持 false：正文里可能有用户手写的任意 HTML
      html: false,
      linkify: true,
      breaks: true,
      // 中文排版里 typographer 会把引号替换成弯引号，与用户原文不符，关掉
      typographer: false,
      highlight: function (code, lang) {
        var hljs = window.hljs;
        if (hljs) {
          try {
            if (lang && hljs.getLanguage(lang)) {
              return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
            }
            return hljs.highlightAuto(code).value;
          } catch (error) {
            /* 高亮失败就退回纯文本 */
          }
        }
        return "";
      },
    });

    mathPlugin(md);
    attachmentRule(md);
    linkRule(md);
    highlightClassRule(md);
    if (typeof window.markdownitTaskLists === "function") {
      md.use(window.markdownitTaskLists, { enabled: false, label: true, labelAfter: true });
    }
    return md;
  }

  /**
   * 渲染 Markdown 为 HTML。
   * @param {string} source
   * @returns {string}
   */
  function render(source) {
    var text = String(source == null ? "" : source);
    var instance = ensureInstance();
    if (!instance) {
      // 库未加载：至少保证内容可读，而不是白屏
      return '<pre class="md-fallback">' + escapeHtml(text) + "</pre>";
    }
    var html = instance.render(text);
    return restoreAllowedTags(html);
  }

  /** 供编辑器工具栏/导出复用：把一段 Markdown 渲染进某个容器。 */
  function renderInto(container, source) {
    if (!container) return;
    container.innerHTML = render(source);
  }

  /**
   * 填充图片等异步内容。
   *
   * 目前只处理附件图片：把 data-file-id 交给取图函数，取回 data URI 后填进 src。
   * 取图失败降级为「文件名 + 提示」，不让用户看到破图。
   *
   * @param {HTMLElement} container
   * @param {(fileId:string)=>Promise<string|null>} resolveImage 返回 data URI 或 null
   */
  function hydrate(container, resolveImage) {
    if (!container || typeof resolveImage !== "function") return Promise.resolve();
    var images = container.querySelectorAll("img.md-attachment[data-file-id]");
    var jobs = [];
    for (var i = 0; i < images.length; i += 1) {
      (function (img) {
        var fileId = img.getAttribute("data-file-id");
        if (!fileId || img.dataset.loaded === "1") return;
        img.dataset.loaded = "1";
        jobs.push(
          resolveImage(fileId)
            .then(function (dataUri) {
              if (dataUri) {
                img.src = dataUri;
                img.classList.add("is-loaded");
              } else {
                markImageFailed(img);
              }
            })
            .catch(function () {
              markImageFailed(img);
            }),
        );
      })(images[i]);
    }
    return Promise.all(jobs);
  }

  function markImageFailed(img) {
    img.classList.add("is-failed");
    var note = document.createElement("span");
    note.className = "attachment-failed";
    note.textContent = "🖼 图片暂不可用";
    if (img.parentNode) img.parentNode.replaceChild(note, img);
  }

  window.MiNoteMarkdown = {
    render: render,
    renderInto: renderInto,
    hydrate: hydrate,
    escapeHtml: escapeHtml,
    /** 供测试断言「库确实加载了」 */
    isReady: function () {
      return md !== null;
    },
  };
})();
