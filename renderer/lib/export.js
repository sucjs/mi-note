/**
 * 小米笔记 —— 导出（Markdown / 自包含 HTML）。
 *
 * 为什么走剪贴板 / 浏览器下载，而不是写文件：
 *   宿主没有「另存为」对话框，要落地到文件只能「先选目录再写」，
 *   那需要 `fs.read`（选目录）+ `fs.write`（写文件）两个权限。
 *   本项目对外承诺「不读也不写你的工作区文件」，为导出破坏这个承诺不值得，
 *   所以导出 = 生成内容 → 剪贴板（或浏览器原生下载）→ 用户自己保存。
 *
 * 样式与字体从 `lib/assets.js` 取（由 tools/embed-assets.js 在打包前生成）。
 * 面板是 file:// 沙箱页，脚本读不了同目录的 vendor 文件，所以必须预先把
 * KaTeX 的 woff2 内联成 data URI —— 这样导出的 HTML 才是真正自包含、离线可看的。
 */
(function () {
  "use strict";

  /** 导出 HTML 的正文样式：与面板预览同一套观感，但用绝对色值（不依赖宿主主题变量）。 */
  var BASE_CSS = [
    ":root { color-scheme: light; }",
    "body {",
    "  margin: 0; padding: 40px 20px;",
    "  background: #ffffff; color: #1a1c1f;",
    "  font: 15px/1.72 -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei\", system-ui, sans-serif;",
    "}",
    ".md-body { max-width: 78ch; margin: 0 auto; word-wrap: break-word; }",
    ".md-body > *:first-child { margin-top: 0; }",
    ".md-body h1 { font-size: 1.65em; margin: 1.3em 0 .5em; padding-bottom: .25em; border-bottom: 1px solid #e3e3e3; }",
    ".md-body h2 { font-size: 1.35em; margin: 1.3em 0 .5em; padding-bottom: .2em; border-bottom: 1px solid #e3e3e3; }",
    ".md-body h3 { font-size: 1.15em; margin: 1.2em 0 .45em; }",
    ".md-body h4, .md-body h5, .md-body h6 { font-size: 1em; margin: 1.1em 0 .4em; }",
    ".md-body p { margin: .7em 0; }",
    ".md-body ul, .md-body ol { margin: .6em 0; padding-left: 1.6em; }",
    ".md-body li { margin: .2em 0; }",
    ".md-body code {",
    "  border-radius: 4px; padding: .1em .35em; background: rgba(26,28,31,.07);",
    "  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .88em;",
    "}",
    ".md-body pre {",
    "  margin: .8em 0; overflow: auto; border: 1px solid #e3e3e3; border-radius: 8px;",
    "  padding: 10px 12px; background: rgba(26,28,31,.03);",
    "}",
    ".md-body pre code { background: transparent; padding: 0; }",
    ".md-body blockquote {",
    "  margin: .8em 0; padding: .1em 0 .1em 1em;",
    "  border-left: 3px solid rgba(26,28,31,.2); color: #5d5d5d;",
    "}",
    ".md-body hr { height: 1px; margin: 1.5em 0; border: 0; background: #d0d0d0; }",
    ".md-body a { color: #ff6a00; }",
    ".md-body img { max-width: 100%; border-radius: 6px; }",
    ".md-body table { border-collapse: collapse; margin: .8em 0; font-size: .95em; }",
    ".md-body th, .md-body td { border: 1px solid #d0d0d0; padding: 4px 10px; }",
    ".md-body th { background: rgba(26,28,31,.04); }",
    ".md-body .task-list-item { list-style: none; margin-left: -1.35em; }",
    ".md-body .task-list-item input { margin-right: .5em; vertical-align: middle; }",
    ".md-body .katex-block { margin: 1em 0; overflow-x: auto; }",
  ].join("\n");

  /** 深色导出：正文与代码块一起换色，避免「白底 + 深色代码块」的割裂感。 */
  var DARK_CSS = [
    ":root { color-scheme: dark; }",
    "body { background: #1a1c1f; color: #e6e6e6; }",
    ".md-body h1, .md-body h2 { border-bottom-color: #3a3d42; }",
    ".md-body code { background: rgba(255,255,255,.09); }",
    ".md-body pre { border-color: #3a3d42; background: rgba(255,255,255,.04); }",
    ".md-body blockquote { border-left-color: rgba(255,255,255,.22); color: #a8a8a8; }",
    ".md-body hr { background: #3a3d42; }",
    ".md-body a { color: #ff8c3a; }",
    ".md-body th, .md-body td { border-color: #3a3d42; }",
    ".md-body th { background: rgba(255,255,255,.05); }",
  ].join("\n");

  /** 取构建期烧进来的样式；缺了就说清楚该怎么修，而不是静默产出一个没样式的文件。 */
  function assets() {
    var bundle = window.MiNoteAssets;
    if (!bundle || !bundle.katexCss) {
      throw new Error("缺少 lib/assets.js，请先执行 node tools/embed-assets.js");
    }
    return bundle;
  }

  /**
   * 生成自包含 HTML。
   *
   * 异步是因为要把附件图片取回来内联：导出文件是给「离开本机、离开小米云」
   * 的场景看的，留着 data-file-id 骨架就等于导出后图片全空。
   *
   * @param {string} title 笔记标题（作为 <title>）
   * @param {string} markdown 正文
   * @param {object} [opts]
   * @param {string} [opts.theme] "light"（默认）或 "dark"
   * @param {(fileId:string)=>Promise<string|null>} [opts.resolveImage] 取附件 data URI
   * @returns {Promise<string>}
   */
  async function toHtml(title, markdown, opts) {
    opts = opts || {};
    var bundle = assets();
    var theme = opts.theme === "dark" ? "dark" : "light";
    var safeTitle = window.MiNoteMarkdown.escapeHtml(title || "无标题笔记");
    var body = window.MiNoteMarkdown.render(markdown || "");

    // 在字符串阶段把图片内联，而不是先建 DOM 再序列化：
    // 后者会把面板的临时属性（data-loaded 等）一并带进导出文件。
    if (typeof opts.resolveImage === "function") {
      body = await inlineImages(body, opts.resolveImage);
    }

    return [
      "<!doctype html>",
      '<html lang="zh-CN">',
      "<head>",
      '<meta charset="UTF-8" />',
      '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      "<title>" + safeTitle + "</title>",
      "<style>",
      BASE_CSS,
      theme === "dark" ? DARK_CSS : "",
      theme === "dark" ? bundle.hljsDarkCss : bundle.hljsLightCss,
      bundle.katexCss,
      "</style>",
      "</head>",
      "<body>",
      '<div class="md-body">',
      body,
      "</div>",
      "</body>",
      "</html>",
      "",
    ].join("\n");
  }

  /**
   * 把渲染结果里带 data-file-id 的附件图片换成内联 data URI。
   *
   * 取不到就换成一行文字提示：导出文件里留一个空 <img> 是最坏的结果 ——
   * 用户看不出是「没导出成功」还是「本来就没图」。
   */
  async function inlineImages(html, resolveImage) {
    var ids = [];
    var pattern = /<img class="md-attachment" data-file-id="([^"]+)"[^>]*>/g;
    var match;
    while ((match = pattern.exec(html)) !== null) {
      if (ids.indexOf(match[1]) === -1) ids.push(match[1]);
    }
    if (ids.length === 0) return html;

    var resolved = {};
    var results = await Promise.all(
      ids.map(function (id) {
        return Promise.resolve()
          .then(function () {
            return resolveImage(id);
          })
          .catch(function () {
            return null;
          });
      }),
    );
    for (var i = 0; i < ids.length; i += 1) resolved[ids[i]] = results[i];

    return html.replace(/<img class="md-attachment" data-file-id="([^"]+)"([^>]*)>/g, function (
      _all,
      id,
      rest,
    ) {
      var uri = resolved[id];
      if (uri) {
        // 把渲染器给的 src="" 换成真图；保留 alt 等其余属性
        return (
          '<img class="md-attachment is-loaded" data-file-id="' +
          id +
          '"' +
          rest.replace(/\ssrc=""/, "") +
          ' src="' +
          uri +
          '" />'
        );
      }
      return '<span class="attachment-failed">🖼 图片未导出（原图未能取回）</span>';
    });
  }

  /** 正文里是否还有没内联的图片（供导出前提示用）。 */
  function countAttachments(markdown) {
    var match = String(markdown || "").match(/!\[[^\]]*\]\(mi-note:\/\/image\/[^)]+\)/g);
    return match ? match.length : 0;
  }

  /** 导出用的文件名（去掉路径分隔符等非法字符）。 */
  function suggestFileName(title, ext) {
    var name = String(title || "无标题笔记")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .trim();
    if (!name) name = "无标题笔记";
    // 太长的标题在部分文件系统上会失败
    if (name.length > 80) name = name.slice(0, 80);
    return name + "." + ext;
  }

  /** 导出文件的规模提示，避免用户复制了才发现几百 KB。 */
  function describe(html) {
    return Math.max(1, Math.round(html.length / 1024)) + " KB";
  }

  window.MiNoteExport = {
    toHtml: toHtml,
    suggestFileName: suggestFileName,
    describe: describe,
    countAttachments: countAttachments,
    /** 供测试断言样式是否真的被内联 */
    _internals: { BASE_CSS: BASE_CSS, DARK_CSS: DARK_CSS },
  };
})();
