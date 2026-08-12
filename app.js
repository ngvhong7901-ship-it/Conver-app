(function () {
  "use strict";

  // ---- Elements ----
  const tabs = document.querySelectorAll(".pane-tab");
  const panes = {
    "pane-input": document.getElementById("pane-input"),
    "pane-preview": document.getElementById("pane-preview"),
  };

  const rawInput = document.getElementById("raw-input");
  const inputWrap = document.querySelector(".input-wrap");
  const charCount = document.getElementById("char-count");
  const btnProcess = document.getElementById("btn-process");
  const btnExport = document.getElementById("btn-export");
  const btnCopy = document.getElementById("btn-copy");
  const previewWrap = document.querySelector(".preview-wrap");
  const previewContent = document.getElementById("preview-content");
  const statusHint = document.getElementById("status-hint");
  const toastStack = document.getElementById("toast-stack");

  // ---- Toasts (stage 9) ----
  // Lightweight, non-blocking notifications for success/warning/error states
  // that don't fit in the small status-hint text (e.g. "3 công thức lỗi").
  const TOAST_ICONS = {
    success: '<svg viewBox="0 0 20 20" width="16" height="16" fill="none"><path d="M4 10.5L8 14.5L16 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    error: '<svg viewBox="0 0 20 20" width="16" height="16" fill="none"><circle cx="10" cy="10" r="7.2" stroke="currentColor" stroke-width="1.6"/><path d="M10 6.5V10.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="13.3" r="0.9" fill="currentColor"/></svg>',
    warning: '<svg viewBox="0 0 20 20" width="16" height="16" fill="none"><path d="M10 3.5L17.5 16.5H2.5L10 3.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 8.5V12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="14.3" r="0.9" fill="currentColor"/></svg>',
    info: '<svg viewBox="0 0 20 20" width="16" height="16" fill="none"><circle cx="10" cy="10" r="7.2" stroke="currentColor" stroke-width="1.6"/><path d="M10 9V14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="6.3" r="0.9" fill="currentColor"/></svg>',
  };

  function showToast(message, type, duration) {
    if (!toastStack) return;
    type = type || "info";
    duration = duration || (type === "error" ? 6000 : 4000);

    const toast = document.createElement("div");
    toast.className = `toast is-${type}`;
    toast.innerHTML = `
      <span class="toast-icon" aria-hidden="true">${TOAST_ICONS[type] || TOAST_ICONS.info}</span>
      <span class="toast-body"></span>
      <button type="button" class="toast-close" aria-label="Đóng thông báo">×</button>
    `;
    toast.querySelector(".toast-body").textContent = message;

    function remove() {
      if (!toast.isConnected) return;
      toast.classList.add("is-leaving");
      setTimeout(() => toast.remove(), 160);
    }
    toast.querySelector(".toast-close").addEventListener("click", remove);
    const timer = setTimeout(remove, duration);
    toast.addEventListener("mouseenter", () => clearTimeout(timer));

    toastStack.appendChild(toast);
    return toast;
  }

  function setButtonLoading(btn, loading) {
    btn.classList.toggle("is-loading", loading);
    btn.disabled = loading || btn.dataset.keepEnabled === "1";
  }

  // ---- Mobile tab switching ----
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => {
        t.classList.remove("is-active");
        t.setAttribute("aria-selected", "false");
      });
      tab.classList.add("is-active");
      tab.setAttribute("aria-selected", "true");

      Object.values(panes).forEach((p) => p.classList.remove("is-active"));
      panes[tab.dataset.target].classList.add("is-active");
    });
  });

  function goToPreviewTab() {
    const previewTab = document.querySelector('.pane-tab[data-target="pane-preview"]');
    if (previewTab) previewTab.click();
  }

  // ---- Input state ----
  function updateInputState() {
    const value = rawInput.value;
    const count = value.length;
    charCount.textContent = count.toLocaleString("vi-VN") + " ký tự";
    inputWrap.classList.toggle("has-content", count > 0);
    btnProcess.disabled = count === 0;
  }

  rawInput.addEventListener("input", updateInputState);
  updateInputState();

  // ---- Process (paste-in -> preview) ----
  // Pipeline (stage 2 + stage 3):
  //   1. Protect fenced code blocks / inline code from math + markdown mangling.
  //   2. Protect math ($$..$$, \[..\], $..$, \(..\)) so markdown parsing
  //      (marked.js) never touches backslashes / underscores / asterisks
  //      inside LaTeX.
  //   3. Run marked.js over the remaining text -> HTML (headings, bold,
  //      italic, lists, blockquote, code).
  //   4. Restore math placeholders as real KaTeX-rendered markup.
  // This entry point (renderPreview) stays the same for later stages
  // (tables, contenteditable, docx export).

  if (window.marked) {
    marked.setOptions({ gfm: true, breaks: true });
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // Pulls out fenced code blocks (```lang\n...\n```) and inline code
  // (`...`) so nothing inside them gets treated as math or markdown.
  function protectCode(text) {
    const store = [];
    function stash(raw) {
      const token = `\u0002CODE${store.length}\u0002`;
      store.push(raw);
      return token;
    }
    let out = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (m) => stash(m));
    out = out.replace(/`[^`\n]+`/g, (m) => stash(m));
    return { text: out, store };
  }

  function restoreCode(text, store) {
    return text.replace(/\u0002CODE(\d+)\u0002/g, (_, i) => store[+i]);
  }

  // Pulls out LaTeX math (block first, then inline) from plain text and
  // replaces it with a placeholder token so marked.js never sees it.
  function protectMath(text) {
    const store = [];
    function stash(latex, display) {
      const token = `\u0002MATH${store.length}\u0002`;
      store.push({ latex, display });
      return token;
    }
    let out = text
      // block math: $$...$$
      .replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => stash(expr.trim(), true))
      // block math: \[...\]
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, expr) => stash(expr.trim(), true))
      // inline math: \(...\)
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, expr) => stash(expr.trim(), false))
      // inline math: $...$ (single line, not touching whitespace right
      // after the opening $ or before the closing $, to avoid grabbing
      // stray currency signs like "costs $5 and $10")
      .replace(/\$([^\s$][^$\n]*?[^\s$]|[^\s$])\$/g, (_, expr) => stash(expr.trim(), false));
    return { text: out, store };
  }

  function renderMathToken(item) {
    if (!window.katex) {
      const safe = escapeHtml(item.display ? `$$${item.latex}$$` : `$${item.latex}$`);
      return safe;
    }
    try {
      return katex.renderToString(item.latex, {
        displayMode: item.display,
        throwOnError: false,
        strict: "ignore",
      });
    } catch (e) {
      return `<span class="math-error" title="${escapeHtml(e.message)}">${escapeHtml(item.latex)}</span>`;
    }
  }

  function restoreMath(html, store) {
    // Block math sitting alone in its own <p>: unwrap the <p> so the
    // KaTeX display block isn't nested inside a paragraph element.
    html = html.replace(/<p>\u0002MATH(\d+)\u0002<\/p>/g, (_, i) => {
      const item = store[+i];
      const rendered = renderMathToken(item);
      return item.display ? `<div class="math-block">${rendered}</div>` : `<p>${rendered}</p>`;
    });
    // Any remaining (inline, or block math mid-paragraph) tokens.
    html = html.replace(/\u0002MATH(\d+)\u0002/g, (_, i) => {
      const item = store[+i];
      const rendered = renderMathToken(item);
      return item.display ? `<span class="math-block-inline">${rendered}</span>` : rendered;
    });
    return html;
  }

  // ---- Tables (stage 4) ----
  // marked.js (gfm:true) already turns `| a | b |` markdown tables into
  // real <table> markup, and — since we never sanitize — raw <table>...
  // </table> HTML pasted straight from a webpage passes through untouched
  // too. Both cases land here as plain <table> elements; we just need to
  // dress them up and make them editable.
  function enhanceTables(container) {
    const tables = container.querySelectorAll("table");
    tables.forEach((table) => {
      if (table.closest(".table-wrap")) return; // already enhanced

      // Normalize: raw pasted HTML tables don't always have <tbody>.
      if (!table.tBodies.length) {
        const tbody = document.createElement("tbody");
        while (table.rows.length && table.rows[0].parentNode === table) {
          tbody.appendChild(table.rows[0]);
        }
        table.appendChild(tbody);
      }

      const wrap = document.createElement("div");
      wrap.className = "table-wrap";
      table.parentNode.insertBefore(wrap, table);

      const scroll = document.createElement("div");
      scroll.className = "table-scroll";
      scroll.appendChild(table);
      wrap.appendChild(scroll);

      const toolbar = document.createElement("div");
      toolbar.className = "table-toolbar";
      toolbar.setAttribute("contenteditable", "false");
      toolbar.innerHTML = `
        <button type="button" class="table-btn" data-action="add-row">+ Hàng</button>
        <button type="button" class="table-btn" data-action="add-col">+ Cột</button>
        <button type="button" class="table-btn is-danger" data-action="del-row">− Hàng</button>
        <button type="button" class="table-btn is-danger" data-action="del-col">− Cột</button>
      `;
      wrap.appendChild(toolbar);
    });
  }

  function colCount(table) {
    const firstRow = table.rows[0];
    if (!firstRow) return 0;
    let n = 0;
    firstRow.querySelectorAll(":scope > th, :scope > td").forEach((c) => (n += c.colSpan || 1));
    return n;
  }

  function tableAddRow(table) {
    const n = colCount(table);
    if (!n) return;
    const body = table.tBodies[0] || table.appendChild(document.createElement("tbody"));
    const row = document.createElement("tr");
    for (let i = 0; i < n; i++) {
      const td = document.createElement("td");
      td.innerHTML = "<br>";
      row.appendChild(td);
    }
    body.appendChild(row);
  }

  function tableDelRow(table) {
    const body = table.tBodies[0];
    if (!body || !body.rows.length) return;
    body.deleteRow(body.rows.length - 1);
  }

  function tableAddCol(table) {
    Array.from(table.rows).forEach((row) => {
      const isHeaderRow = row.parentNode.tagName === "THEAD";
      const cell = document.createElement(isHeaderRow ? "th" : "td");
      cell.innerHTML = "<br>";
      row.appendChild(cell);
    });
  }

  function tableDelCol(table) {
    if (colCount(table) <= 1) return;
    Array.from(table.rows).forEach((row) => {
      if (row.cells.length) row.deleteCell(row.cells.length - 1);
    });
  }

  previewContent.addEventListener("click", (e) => {
    const btn = e.target.closest(".table-btn");
    if (!btn) return;
    e.preventDefault();
    const table = btn.closest(".table-wrap").querySelector("table");
    if (!table) return;
    const action = btn.dataset.action;
    if (action === "add-row") tableAddRow(table);
    if (action === "del-row") tableDelRow(table);
    if (action === "add-col") tableAddCol(table);
    if (action === "del-col") tableDelCol(table);
  });

  // ---- Editing experience (stage 5) ----
  // - Use <p> as the default block instead of the browser's <div> so
  //   pressing Enter in normal text keeps the same styling as the parsed
  //   markdown paragraphs.
  // - Enter inside a table cell inserts a line break instead of trying to
  //   escape the table or split it.
  // - Tab / Shift+Tab hops between cells, spreadsheet-style.
  previewContent.addEventListener("focus", () => {
    try {
      document.execCommand("defaultParagraphSeparator", false, "p");
    } catch (e) {
      /* not fatal if unsupported */
    }
  });

  function cellAt(row, index) {
    return row && row.cells ? row.cells[index] : null;
  }

  function placeCursorIn(cell) {
    if (!cell) return false;
    cell.focus();
    const range = document.createRange();
    range.selectNodeContents(cell);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }

  previewContent.addEventListener("keydown", (e) => {
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode) return;
    const cell = sel.anchorNode.nodeType === 1
      ? sel.anchorNode.closest("td, th")
      : sel.anchorNode.parentElement && sel.anchorNode.parentElement.closest("td, th");

    if (cell && e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      document.execCommand("insertLineBreak");
      return;
    }

    if (cell && e.key === "Tab") {
      e.preventDefault();
      const row = cell.parentElement;
      const cellIndex = Array.from(row.cells).indexOf(cell);
      let targetRow = row;
      let targetIndex = cellIndex + (e.shiftKey ? -1 : 1);

      if (targetIndex < 0 || targetIndex >= row.cells.length) {
        // Move to the previous/next row, wrapping across thead/tbody.
        const table = cell.closest("table");
        const allRows = Array.from(table.rows);
        const rowIndex = allRows.indexOf(row);
        const nextRowIndex = rowIndex + (e.shiftKey ? -1 : 1);
        targetRow = allRows[nextRowIndex];
        if (!targetRow && !e.shiftKey) {
          // Tabbing past the last cell of the last row: grow the table.
          tableAddRow(table);
          targetRow = Array.from(table.rows).pop();
        }
        targetIndex = e.shiftKey ? (targetRow ? targetRow.cells.length - 1 : 0) : 0;
      }
      placeCursorIn(cellAt(targetRow, targetIndex));
    }
  });

  function renderPreview(rawText) {
    // Fallback if libraries somehow failed to load from the CDN.
    if (!window.marked) {
      const escaped = escapeHtml(rawText);
      previewContent.innerHTML = escaped
        .split(/\n{2,}/)
        .map((block) => `<p>${block.replace(/\n/g, "<br>")}</p>`)
        .join("");
      showToast("Không tải được thư viện Markdown (marked.js) — đang hiển thị văn bản thô. Kiểm tra kết nối mạng rồi thử lại.", "warning");
      return;
    }

    const codeProtected = protectCode(rawText);
    const mathProtected = protectMath(codeProtected.text);
    const restoredCode = restoreCode(mathProtected.text, codeProtected.store);

    let html = marked.parse(restoredCode);
    html = restoreMath(html, mathProtected.store);

    previewContent.innerHTML = html;
    enhanceTables(previewContent);

    // Surface anything that didn't come out clean instead of failing
    // silently: broken formulas render as .math-error spans (see
    // renderMathToken), so count them and let the person know exactly
    // what to check rather than a generic "something went wrong".
    const errorCount = previewContent.querySelectorAll(".math-error").length;
    if (errorCount === 1) {
      showToast("Có 1 công thức toán không đọc được cú pháp LaTeX — đã đánh dấu màu đỏ trong bản xem trước.", "warning");
    } else if (errorCount > 1) {
      showToast(`Có ${errorCount} công thức toán không đọc được cú pháp LaTeX — đã đánh dấu màu đỏ trong bản xem trước.`, "warning");
    }
  }

  btnProcess.addEventListener("click", () => {
    const value = rawInput.value.trim();
    if (!value) return;

    setButtonLoading(btnProcess, true);
    statusHint.textContent = "Đang xử lý…";

    // Defer to the next frame so the spinner actually paints before the
    // (synchronous, potentially heavy on long chats) parse/render runs.
    setTimeout(() => {
      try {
        renderPreview(rawInput.value);
        previewWrap.classList.add("has-preview");
        previewContent.setAttribute("contenteditable", "true");
        btnExport.disabled = false;
        btnCopy.disabled = false;
        statusHint.textContent = "Đã tạo bản xem trước — có thể chỉnh sửa";
        goToPreviewTab();
      } catch (err) {
        console.error(err);
        statusHint.textContent = "Không nhận diện được nội dung vừa dán.";
        showToast("Không xử lý được nội dung vừa dán — thử dán lại, hoặc bỏ bớt phần định dạng lạ rồi thử lại.", "error");
      } finally {
        setButtonLoading(btnProcess, false);
      }
    }, 10);
  });

  // ---- Quick copy (stage 9) ----
  // Copies the edited preview as rich text (so pasting into Word/Docs/Gmail
  // keeps bold/tables/formulas as images-of-text where rich paste is
  // supported) with a plain-text fallback for anywhere that only accepts
  // plain text, or for browsers without ClipboardItem support.
  async function copyPreview() {
    if (!previewContent.textContent.trim()) return;

    const htmlBlob = new Blob([previewContent.innerHTML], { type: "text/html" });
    const textBlob = new Blob([previewContent.innerText], { type: "text/plain" });

    try {
      if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([
          new ClipboardItem({ "text/html": htmlBlob, "text/plain": textBlob }),
        ]);
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(previewContent.innerText);
      } else {
        throw new Error("Trình duyệt không hỗ trợ sao chép tự động");
      }

      btnCopy.classList.add("is-copied");
      const labelEl = btnCopy.querySelector(".btn-label");
      const original = labelEl.textContent;
      labelEl.textContent = "Đã sao chép ✓";
      setTimeout(() => {
        btnCopy.classList.remove("is-copied");
        labelEl.textContent = original;
      }, 1800);
    } catch (err) {
      console.error(err);
      showToast("Không sao chép được — trình duyệt chặn quyền truy cập clipboard. Bạn có thể chọn thủ công (Ctrl/Cmd+A rồi Ctrl/Cmd+C) trong khung xem trước.", "error");
    }
  }

  btnCopy.addEventListener("click", copyPreview);

  // ---- Export to Word (stage 6) — plus stage 7: real Word formulas (OMML) ----
  // Walks the (edited) preview DOM and rebuilds it as a real .docx using
  // docx.js (loaded as a UMD global `docx`). Text/formatting scope: headings,
  // bold/italic/underline/strike, inline code, fenced code blocks, bullet &
  // numbered lists (incl. nesting), blockquotes, links, and plain tables.
  //
  // Math (stage 7): KaTeX renders each formula with `output: "htmlAndMathml"`
  // by default, so every rendered formula already carries a real <math>
  // (MathML) tree alongside the visual HTML. We run that MathML through
  // Microsoft's own MML2OMML.XSL stylesheet (client-side, via the browser's
  // built-in XSLTProcessor) to get OMML — the XML Word actually stores
  // formulas in — then splice that OMML straight into the .docx using
  // docx.js's ImportedXmlComponent. Net effect: formulas land in Word as
  // live, double-click-to-edit equations, not pictures or plain text.
  // If the stylesheet can't be loaded/applied for some reason (offline,
  // unsupported browser, a malformed formula), each affected formula falls
  // back individually to its LaTeX source wrapped in $…$ / $$…$$ so nothing
  // is silently lost.

  const MML2OMML_URL =
    "https://raw.githubusercontent.com/lavakumarThatisetti/Extracting-Math-formulas-using-Apache-poi-in-java/master/MML2OMML.XSL";
  const OMML_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math";

  // Cached across the whole export: `null` = not yet attempted, a real
  // XSLTProcessor instance = ready, `false` = tried and unavailable.
  let xsltProcessor = null;

  async function ensureXsltProcessor() {
    if (xsltProcessor !== null) return xsltProcessor;
    if (typeof XSLTProcessor === "undefined" || typeof DOMParser === "undefined") {
      xsltProcessor = false;
      return false;
    }
    try {
      const res = await fetch(MML2OMML_URL);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const xsltText = await res.text();
      const xsltDoc = new DOMParser().parseFromString(xsltText, "application/xml");
      if (xsltDoc.querySelector("parsererror")) throw new Error("Không phân tích được XSLT");
      const proc = new XSLTProcessor();
      proc.importStylesheet(xsltDoc);
      xsltProcessor = proc;
    } catch (e) {
      console.warn("Không tải được MML2OMML.XSL — công thức sẽ xuất dạng văn bản LaTeX thay thế.", e);
      xsltProcessor = false;
    }
    return xsltProcessor;
  }

  // Converts a rendered KaTeX node's MathML into an OMML XML string
  // ("<m:oMath …>…</m:oMath>"), or null if that isn't possible right now.
  function mathNodeToOmmlXml(katexRootEl) {
    if (!xsltProcessor) return null;
    try {
      const mathEl = katexRootEl.matches("math") ? katexRootEl : katexRootEl.querySelector("math");
      if (!mathEl) return null;

      // Drop KaTeX's <annotation>/<annotation-xml> (raw LaTeX / other
      // encodings) before transforming: MML2OMML.XSL's catch-all template
      // would otherwise recurse into it and leak stray text into the OMML.
      const clean = mathEl.cloneNode(true);
      clean.querySelectorAll("annotation, annotation-xml").forEach((a) => a.remove());

      const fragment = xsltProcessor.transformToFragment(clean, document);
      const oMathEl = fragment && fragment.firstElementChild;
      if (!oMathEl) return null;

      // The transform can "succeed" (return a well-formed <m:oMath>) while
      // actually matching none of the MathML it was given — KaTeX's MathML
      // output uses nesting/attributes this particular stylesheet doesn't
      // always recognize (e.g. some \sqrt, \frac, or Greek-letter
      // structures), so certain formulas silently come out as an empty
      // shell. An empty OMML node is *worse* than no OMML: Word/WPS render
      // it as literally nothing, and the code never reaches the plain-text
      // fallback below because "we got an element back" looked like
      // success. Guard against that by requiring actual rendered content
      // (any non-whitespace text somewhere inside, e.g. inside <m:t>) —
      // otherwise treat it the same as a failed transform.
      const hasRenderedContent = (oMathEl.textContent || "").replace(/\s+/g, "").length > 0;
      if (!hasRenderedContent) {
        console.warn("Chuyển MathML sang OMML ra kết quả rỗng (không khớp cấu trúc) — dùng văn bản LaTeX thay thế.", clean.outerHTML || clean.textContent);
        return null;
      }

      if (!oMathEl.getAttribute("xmlns:m")) oMathEl.setAttribute("xmlns:m", OMML_NS);
      return new XMLSerializer().serializeToString(oMathEl);
    } catch (e) {
      console.warn("Chuyển MathML sang OMML thất bại cho một công thức, dùng văn bản LaTeX thay thế.", e);
      return null;
    }
  }

  // Builds a docx.js paragraph-child (an ImportedXmlComponent wrapping real
  // OMML) for a KaTeX node, or null if OMML isn't available — in which case
  // the caller should fall back to plain $…$ / $$…$$ text.
  function mathNodeToDocxChild(katexRootEl) {
    if (!docx.ImportedXmlComponent || typeof docx.ImportedXmlComponent.fromXmlString !== "function") return null;
    const xml = mathNodeToOmmlXml(katexRootEl);
    if (!xml) return null;
    try {
      return docx.ImportedXmlComponent.fromXmlString(xml);
    } catch (e) {
      console.warn("Không chèn được OMML vào docx, dùng văn bản LaTeX thay thế.", e);
      return null;
    }
  }

  function getMathSource(el) {
    const annotation = el.querySelector('annotation[encoding="application/x-tex"]');
    if (annotation) return annotation.textContent.trim();
    return el.textContent.trim();
  }

  function isMathNode(el) {
    return !!(
      el.classList &&
      (el.classList.contains("katex") ||
        el.classList.contains("katex-display") ||
        el.classList.contains("math-block-inline") ||
        el.classList.contains("math-error"))
    );
  }

  // ---- inline content (within a paragraph / heading / cell / list item) ----
  function inlineToRuns(node, fmt) {
    const { Run } = docxRuns();
    let runs = [];

    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent;
        if (text) runs.push(makeRun(text, fmt));
        return;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) return;

      const tag = child.tagName;

      if (tag === "BR") {
        runs.push(makeRun("", fmt, true));
        return;
      }

      if (isMathNode(child)) {
        const display = child.classList.contains("katex-display") || child.classList.contains("math-block-inline");
        const omml = mathNodeToDocxChild(child);
        if (omml) {
          runs.push(omml);
          return;
        }
        const src = getMathSource(child);
        const wrapped = display ? `$$${src}$$` : `$${src}$`;
        runs = runs.concat(makeRun(wrapped, { ...fmt, italics: true }));
        return;
      }

      if (tag === "A") {
        const inner = inlineToRuns(child, { ...fmt, underline: true, color: "2563EB" });
        const href = child.getAttribute("href");
        if (href && docx.ExternalHyperlink) {
          runs.push(new docx.ExternalHyperlink({ link: href, children: inner }));
        } else {
          runs = runs.concat(inner);
        }
        return;
      }

      if (tag === "STRONG" || tag === "B") {
        runs = runs.concat(inlineToRuns(child, { ...fmt, bold: true }));
        return;
      }
      if (tag === "EM" || tag === "I") {
        runs = runs.concat(inlineToRuns(child, { ...fmt, italics: true }));
        return;
      }
      if (tag === "U") {
        runs = runs.concat(inlineToRuns(child, { ...fmt, underline: true }));
        return;
      }
      if (tag === "S" || tag === "DEL" || tag === "STRIKE") {
        runs = runs.concat(inlineToRuns(child, { ...fmt, strike: true }));
        return;
      }
      if (tag === "CODE") {
        runs = runs.concat(inlineToRuns(child, { ...fmt, code: true }));
        return;
      }

      // Unknown inline wrapper (SPAN, etc.) — keep formatting, recurse.
      runs = runs.concat(inlineToRuns(child, fmt));
    });

    return runs;
  }

  function makeRun(text, fmt, isBreak) {
    const opts = {
      text: isBreak ? "" : text,
      bold: !!fmt.bold,
      italics: !!fmt.italics,
      underline: fmt.underline ? {} : undefined,
      strike: !!fmt.strike,
      break: isBreak ? 1 : undefined,
    };
    if (fmt.code) {
      opts.font = "JetBrains Mono, Consolas, monospace";
      opts.shading = { type: docx.ShadingType.CLEAR, fill: "F1EFE9" };
    }
    if (fmt.color) opts.color = fmt.color;
    return new docx.TextRun(opts);
  }

  function docxRuns() {
    return { Run: docx.TextRun };
  }

  // Combines a paragraph's own options with "inherited" indent/border coming
  // from an ancestor block (currently: blockquote). Indent accumulates
  // (nested blockquotes indent further); border is inherited as-is.
  function applyInherited(opts, inherited) {
    if (!inherited) return opts;
    const merged = Object.assign({}, opts);
    if (inherited.indent) {
      const ownLeft = (opts.indent && opts.indent.left) || 0;
      merged.indent = Object.assign({}, opts.indent, inherited.indent, { left: ownLeft + inherited.indent.left });
    }
    if (inherited.border && !merged.border) merged.border = inherited.border;
    return merged;
  }

  function paragraphFromInline(el, extraOpts, inherited) {
    const runs = inlineToRuns(el, {});
    if (!runs.length) runs.push(new docx.TextRun({ text: "" }));
    return new docx.Paragraph(applyInherited(Object.assign({ children: runs }, extraOpts || {}), inherited));
  }

  const HEADING_MAP = {
    H1: docx.HeadingLevel.HEADING_1,
    H2: docx.HeadingLevel.HEADING_2,
    H3: docx.HeadingLevel.HEADING_3,
    H4: docx.HeadingLevel.HEADING_4,
    H5: docx.HeadingLevel.HEADING_5,
    H6: docx.HeadingLevel.HEADING_6,
  };

  // ---- lists ----
  function listToParagraphs(listEl, level, inherited) {
    let out = [];
    const isOrdered = listEl.tagName === "OL";
    let n = isOrdered ? Number(listEl.getAttribute("start") || 1) : 0;

    Array.from(listEl.children)
      .filter((c) => c.tagName === "LI")
      .forEach((li) => {
        // Split each <li>'s own inline content away from any nested list.
        const nested = Array.from(li.children).filter((c) => c.tagName === "UL" || c.tagName === "OL");
        const clone = li.cloneNode(true);
        Array.from(clone.children)
          .filter((c) => c.tagName === "UL" || c.tagName === "OL")
          .forEach((c) => c.remove());

        const prefix = isOrdered ? `${n}. ` : "";
        const runs = inlineToRuns(clone, {});
        if (prefix) runs.unshift(new docx.TextRun({ text: prefix }));
        if (!runs.length) runs.push(new docx.TextRun({ text: "" }));

        const paraOpts = { children: runs, indent: { left: 360 + level * 360 } };
        if (!isOrdered) paraOpts.bullet = { level: level };

        out.push(new docx.Paragraph(applyInherited(paraOpts, inherited)));
        if (isOrdered) n += 1;

        nested.forEach((nestedList) => {
          out = out.concat(listToParagraphs(nestedList, level + 1, inherited));
        });
      });
    return out;
  }

  // ---- tables (stage 8) ----
  // Rebuilds each parsed <table> as a real docx Table/TableRow/TableCell
  // tree (cells already carry both text and OMML formulas via
  // inlineToRuns). Column widths are picked from actual cell content
  // length rather than left equal-width, colspan/rowspan are passed
  // straight through (docx.js auto-inserts the merge-continuation cells
  // into following rows for us), and the header row repeats on page
  // breaks since formula-heavy tables can run long.
  function tableToDocxTable(tableEl) {
    const domRows = Array.from(tableEl.rows);
    if (!domRows.length) return null;

    let colCount = 0;
    domRows.forEach((row) => {
      let n = 0;
      Array.from(row.cells).forEach((c) => (n += c.colSpan || 1));
      colCount = Math.max(colCount, n);
    });
    if (!colCount) return null;

    // Width heuristic: look at "regular" rows (no merged cells, full
    // column count) and size each column to its longest cell's text —
    // rows with spans are skipped here so they can't skew the estimate.
    const weights = new Array(colCount).fill(0);
    let sawRegularRow = false;
    domRows.forEach((row) => {
      const cells = Array.from(row.cells);
      const hasSpan = cells.some((c) => (c.colSpan || 1) > 1 || (c.rowSpan || 1) > 1);
      if (hasSpan || cells.length !== colCount) return;
      sawRegularRow = true;
      cells.forEach((c, i) => {
        const len = Math.max(4, Math.min(48, c.textContent.trim().length || 4));
        weights[i] = Math.max(weights[i], len);
      });
    });
    if (!sawRegularRow) weights.fill(10);

    const TOTAL_WIDTH = 9350; // twips (~6.5in), fits a standard A4/Letter page with normal margins
    const MIN_COL = 720; // ~0.5in floor so a narrow column never collapses away
    const weightSum = weights.reduce((a, b) => a + b, 0) || colCount;
    let colWidths = weights.map((w) => Math.max(MIN_COL, Math.round((w / weightSum) * TOTAL_WIDTH)));
    const widthSum = colWidths.reduce((a, b) => a + b, 0);
    if (widthSum !== TOTAL_WIDTH) {
      const scale = TOTAL_WIDTH / widthSum;
      colWidths = colWidths.map((w) => Math.round(w * scale));
    }

    const cellBorder = { style: docx.BorderStyle.SINGLE, size: 4, color: "D8D2C2" };
    const borders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };

    const rows = domRows.map((row) => {
      const isHeaderRow = row.parentNode.tagName === "THEAD";
      const cells = Array.from(row.cells).map((cellEl) => {
        const isHeader = isHeaderRow || cellEl.tagName === "TH";
        const runs = inlineToRuns(cellEl, { bold: isHeader });
        if (!runs.length) runs.push(new docx.TextRun({ text: "" }));
        const opts = {
          children: [new docx.Paragraph({ children: runs })],
          shading: isHeader ? { type: docx.ShadingType.CLEAR, fill: "EFEAE0" } : undefined,
          verticalAlign: docx.VerticalAlign.CENTER,
          margins: { top: 80, bottom: 80, left: 100, right: 100 },
          borders,
        };
        if ((cellEl.colSpan || 1) > 1) opts.columnSpan = cellEl.colSpan;
        if ((cellEl.rowSpan || 1) > 1) opts.rowSpan = cellEl.rowSpan;
        return new docx.TableCell(opts);
      });
      const rowOpts = { children: cells };
      if (isHeaderRow) rowOpts.tableHeader = true;
      return new docx.TableRow(rowOpts);
    });

    if (!rows.length) return null;
    return new docx.Table({
      rows,
      width: { size: TOTAL_WIDTH, type: docx.WidthType.DXA },
      columnWidths: colWidths,
    });
  }

  // ---- block-level dispatch ----
  // `inherited` carries indent/border down from an ancestor <blockquote> so
  // nested paragraphs, lists, and code blocks all pick it up consistently.
  function blockToDocx(el, inherited) {
    const tag = el.tagName;

    if (HEADING_MAP[tag]) {
      return [paragraphFromInline(el, { heading: HEADING_MAP[tag], spacing: { before: 240, after: 120 } }, inherited)];
    }

    if (tag === "P") {
      // A <p> that is *only* a block math placeholder was already unwrapped
      // by restoreMath() into a <div class="math-block">, so a plain <p>
      // here is always regular text (possibly with inline math inside it).
      return [paragraphFromInline(el, { spacing: { after: 160 } }, inherited)];
    }

    if (tag === "UL" || tag === "OL") {
      return listToParagraphs(el, 0, inherited);
    }

    if (tag === "BLOCKQUOTE") {
      const nextInherited = {
        indent: { left: 480 + ((inherited && inherited.indent && inherited.indent.left) || 0) },
        border: { left: { color: "9A9482", space: 8, style: docx.BorderStyle.SINGLE, size: 12 } },
      };
      let out = [];
      Array.from(el.children).forEach((child) => {
        out = out.concat(blockToDocx(child, nextInherited));
      });
      if (!out.length) out = [paragraphFromInline(el, {}, nextInherited)];
      return out;
    }

    if (tag === "PRE") {
      const codeEl = el.querySelector("code") || el;
      const raw = codeEl.textContent.replace(/\n$/, "");
      const lines = raw.split("\n");
      return lines.map((line, i) =>
        new docx.Paragraph(
          applyInherited(
            {
              children: [new docx.TextRun({ text: line || " ", font: "JetBrains Mono, Consolas, monospace" })],
              shading: { type: docx.ShadingType.CLEAR, fill: "F1EFE9" },
              spacing: { before: i === 0 ? 120 : 0, after: i === lines.length - 1 ? 120 : 0 },
            },
            inherited
          )
        )
      );
    }

    if (tag === "DIV" && el.classList.contains("math-block")) {
      const omml = mathNodeToDocxChild(el);
      if (omml) {
        return [
          new docx.Paragraph(
            applyInherited(
              { alignment: docx.AlignmentType.CENTER, spacing: { before: 120, after: 120 }, children: [omml] },
              inherited
            )
          ),
        ];
      }
      const src = getMathSource(el);
      return [
        new docx.Paragraph(
          applyInherited(
            {
              alignment: docx.AlignmentType.CENTER,
              spacing: { before: 120, after: 120 },
              children: [new docx.TextRun({ text: `$$${src}$$`, italics: true })],
            },
            inherited
          )
        ),
      ];
    }

    if (tag === "DIV" && el.classList.contains("table-wrap")) {
      const tableEl = el.querySelector("table");
      const t = tableEl ? tableToDocxTable(tableEl) : null;
      return t ? [t, new docx.Paragraph({ text: "" })] : [];
    }

    if (tag === "HR") {
      return [
        new docx.Paragraph(
          applyInherited(
            {
              border: { bottom: { color: "D8D2C2", space: 1, style: docx.BorderStyle.SINGLE, size: 6 } },
              spacing: { before: 120, after: 120 },
            },
            inherited
          )
        ),
      ];
    }

    if (tag === "TABLE") {
      const t = tableToDocxTable(el);
      return t ? [t, new docx.Paragraph({ text: "" })] : [];
    }

    // Generic container (DIV etc.) — recurse into block children if any,
    // otherwise treat as a plain paragraph.
    const blockChildren = Array.from(el.children).filter((c) =>
      ["H1", "H2", "H3", "H4", "H5", "H6", "P", "UL", "OL", "BLOCKQUOTE", "PRE", "DIV", "TABLE", "HR"].includes(c.tagName)
    );
    if (blockChildren.length) {
      let out = [];
      Array.from(el.childNodes).forEach((child) => {
        if (child.nodeType === Node.ELEMENT_NODE) {
          if (child.classList && child.classList.contains("table-toolbar")) return;
          out = out.concat(blockToDocx(child, inherited));
        } else if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) {
          out.push(new docx.Paragraph(applyInherited({ children: [new docx.TextRun({ text: child.textContent.trim() })] }, inherited)));
        }
      });
      return out;
    }
    return [paragraphFromInline(el, { spacing: { after: 160 } }, inherited)];
  }

  function buildDocxChildren(container) {
    let children = [];
    Array.from(container.childNodes).forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.classList && node.classList.contains("table-toolbar")) return;
        children = children.concat(blockToDocx(node, null));
      } else if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
        children.push(new docx.Paragraph({ children: [new docx.TextRun({ text: node.textContent.trim() })] }));
      }
    });
    if (!children.length) children.push(new docx.Paragraph({ text: "" }));
    return children;
  }

  function guessFilename() {
    const firstHeading = previewContent.querySelector("h1, h2, h3");
    let base = firstHeading ? firstHeading.textContent.trim() : "Sang-export";
    base = base
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60);
    if (!base) base = "Sang-export";
    return `${base}.docx`;
  }

  async function exportToWord() {
    if (!window.docx) {
      statusHint.textContent = "Không tải được thư viện xuất Word (docx.js).";
      showToast("Không tải được thư viện xuất Word (docx.js) — kiểm tra kết nối mạng rồi thử lại.", "error");
      return;
    }
    if (!previewContent.textContent.trim()) {
      showToast("Chưa có nội dung để xuất — hãy dán chat và bấm \"Xem trước\" trước.", "warning");
      return;
    }

    setButtonLoading(btnExport, true);
    statusHint.textContent = "Đang chuẩn bị công thức toán…";

    try {
      await ensureXsltProcessor();
      statusHint.textContent = "Đang dựng file Word…";
      const children = buildDocxChildren(previewContent);
      const doc = new docx.Document({
        creator: "Sang",
        title: "Xuất từ Sang",
        styles: {
          default: {
            document: {
              run: { font: "Inter, Calibri, sans-serif", size: 22 },
            },
          },
        },
        sections: [
          {
            properties: {},
            children,
          },
        ],
      });

      const blob = await docx.Packer.toBlob(doc);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const filename = guessFilename();
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);

      statusHint.textContent = "Đã xuất file Word ✓";
      showToast(`Đã tải "${filename}" — mở bằng Word/Google Docs để kiểm tra lại.`, "success");
    } catch (err) {
      console.error(err);
      statusHint.textContent = "Có lỗi khi xuất Word.";
      showToast("Không xuất được file Word: " + err.message, "error");
    } finally {
      setButtonLoading(btnExport, false);
    }
  }

  btnExport.addEventListener("click", exportToWord);
})();
