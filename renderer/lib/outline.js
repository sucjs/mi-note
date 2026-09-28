/**
 * 小米笔记 —— 大纲（TOC）提取与联动。
 *
 * 从 Markdown 源码里抽 H1–H5，供面板生成目录、滚动联动与点击跳转。
 *
 * 为什么自己扫源码而不是从渲染后的 DOM 取：
 *   编辑模式下没有渲染后的 DOM，而用户在写长文时最需要大纲。
 *   两条路都从同一份源码派生，标题顺序与渲染结果一致（markdown-it 保序）。
 */
(function () {
  "use strict";

  var HEADING_RE = /^(#{1,5})\s+(.+?)\s*#*\s*$/;
  var FENCE_RE = /^\s*(```|~~~)/;

  /**
   * 抽出标题列表。
   *
   * 必须跳过围栏代码块 —— 否则代码里的 `# 注释` 会被当成标题，
   * 目录里凭空多出几条，点击还会跳错位置。
   *
   * @param {string} markdown
   * @returns {Array<{level:number, text:string, index:number}>}
   */
  function extract(markdown) {
    var lines = String(markdown == null ? "" : markdown).split("\n");
    var out = [];
    var fence = null;

    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];

      var fenceMatch = line.match(FENCE_RE);
      if (fenceMatch) {
        var marker = fenceMatch[1];
        if (fence === null) fence = marker;
        else if (fence === marker) fence = null;
        continue;
      }
      if (fence !== null) continue;

      var match = line.match(HEADING_RE);
      if (!match) continue;
      var text = stripInline(match[2]);
      if (!text) continue;
      out.push({ level: match[1].length, text: text, index: out.length });
    }
    return out;
  }

  /** 标题里的行内标记去掉，目录里不该显示 `**`。 */
  function stripInline(text) {
    return String(text)
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1$2")
      .replace(/~~([^~]+)~~/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .trim();
  }

  /**
   * 给渲染后的标题元素补上 id，使其与 extract() 的下标一一对应。
   *
   * 用**顺序**对齐而不是文本匹配：同名标题很常见（「备注」「总结」），
   * 按文本找会跳错。
   *
   * @param {HTMLElement} container 渲染后的 .md-body
   * @returns {HTMLElement[]} 按顺序的标题元素
   */
  function decorate(container) {
    if (!container) return [];
    var nodes = container.querySelectorAll("h1, h2, h3, h4, h5");
    var out = [];
    for (var i = 0; i < nodes.length; i += 1) {
      nodes[i].id = headingId(i);
      out.push(nodes[i]);
    }
    return out;
  }

  function headingId(index) {
    return "md-h-" + index;
  }

  /**
   * 滚动联动：回报「当前所在的那一节」。
   *
   * 用「比较各标题相对滚动容器顶部的位置」而不是 IntersectionObserver：
   * 观察者的回调只报告**状态变化过**的元素，快速拖动滚动条时可能出现
   * 中间态里一个都不在观察带内的情况，此时集合为空、状态就卡在上一次的值
   * （实测：滚到底部大纲仍高亮第一个标题）。按位置算每次都能得到确定答案。
   *
   * 用 rAF 节流：scroll 事件触发极频繁，但一帧只需要算一次。
   *
   * @param {HTMLElement} scrollRoot 滚动容器
   * @param {HTMLElement[]} headings 标题元素（decorate 的返回值）
   * @param {(index:number)=>void} onChange
   * @returns {() => void} 停止监听
   */
  function watchScroll(scrollRoot, headings, onChange) {
    if (!scrollRoot || !headings.length) return function () {};

    var ticking = false;
    var lastIndex = -1;
    /** 判定「当前节」时允许的顶部偏移：标题进入顶部 15% 区域就算当前。 */
    var TOP_BAND = 0.15;

    var measure = function () {
      ticking = false;
      var rootRect = scrollRoot.getBoundingClientRect();
      var threshold = rootRect.top + rootRect.height * TOP_BAND;
      var current = 0;
      for (var i = 0; i < headings.length; i += 1) {
        if (headings[i].getBoundingClientRect().top <= threshold) current = i;
        else break;
      }
      /*
       * 短文档滚到底时，最后几个标题可能都还在判定带下方，
       * 于是大纲停在中间某一节，看着像「跳不过去」。
       * 用户已经滚到末尾了，那就是在最后一节里 —— 直接选最后一个。
       */
      var atBottom = scrollRoot.scrollTop + scrollRoot.clientHeight >= scrollRoot.scrollHeight - 2;
      if (atBottom) current = headings.length - 1;
      if (current !== lastIndex) {
        lastIndex = current;
        onChange(current);
      }
    };

    var onScroll = function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(measure);
    };

    scrollRoot.addEventListener("scroll", onScroll, { passive: true });
    // 首次立即算一次，不必等用户滚动
    measure();

    return function () {
      scrollRoot.removeEventListener("scroll", onScroll);
    };
  }

  window.MiNoteOutline = {
    extract: extract,
    decorate: decorate,
    watchScroll: watchScroll,
    headingId: headingId,
  };
})();
