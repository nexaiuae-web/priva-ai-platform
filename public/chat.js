(function () {
  "use strict";

  const STORAGE_SESSIONS = "priva_chat_sessions_v1";
  const STORAGE_SETTINGS = "priva_chat_settings_v1";

  const el = {
    sidebar: document.getElementById("sidebar-chats"),
    btnNew: document.getElementById("btn-new-chat"),
    masterKey: document.getElementById("input-master-key"),
    companyId: document.getElementById("input-company-id"),
    messagesList: document.getElementById("messages-list"),
    messagesScroll: document.getElementById("messages-scroll"),
    chatTitle: document.getElementById("chat-title"),
    sourcesPanel: document.getElementById("sources-panel"),
    sourcesList: document.getElementById("sources-list"),
    input: document.getElementById("input-message"),
    btnSend: document.getElementById("btn-send"),
    status: document.getElementById("status-badge"),
    toast: document.getElementById("toast"),
    uploadKnowledgeBtn: document.getElementById("uploadKnowledgeBtn"),
    knowledgeFileInput: document.getElementById("knowledgeFileInput"),
    knowledgeList: document.getElementById("knowledgeList"),
    knowledgeSection: document.getElementById("knowledge-section"),
    uploadProgressWrap: document.getElementById("upload-progress-wrap"),
    uploadProgressBar: document.getElementById("upload-progress-bar"),
    uploadProgressPct: document.getElementById("upload-progress-pct"),
    uploadProgressLabel: document.getElementById("upload-progress-label"),
    uploadProgressPhase: document.getElementById("upload-progress-phase"),
    uploadProgressDetail: document.getElementById("upload-progress-detail"),
  };

  function ensureUploadProgressUi() {
    if (
      el.uploadProgressWrap &&
      el.uploadProgressBar &&
      el.uploadProgressPhase &&
      el.uploadProgressDetail
    ) {
      return el.uploadProgressWrap;
    }

    const anchor = el.knowledgeList || el.knowledgeSection || document.body;
    const wrap = document.createElement("div");
    wrap.id = "upload-progress-wrap";
    wrap.className =
      "mb-3 rounded-lg border border-emerald-200 bg-emerald-50/90 p-3 shadow-sm transition-opacity duration-300";
    wrap.setAttribute("role", "status");
    wrap.setAttribute("aria-live", "polite");
    wrap.style.display = "none";
    wrap.style.opacity = "0";

    const row = document.createElement("div");
    row.className = "mb-2 flex items-center justify-between gap-2";

    const phase = document.createElement("span");
    phase.id = "upload-progress-phase";
    phase.className =
      "rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800";
    phase.textContent = "Uploading";

    const pct = document.createElement("span");
    pct.id = "upload-progress-pct";
    pct.className = "text-sm font-bold tabular-nums text-emerald-700";
    pct.textContent = "0%";
    row.appendChild(phase);
    row.appendChild(pct);

    const label = document.createElement("p");
    label.id = "upload-progress-label";
    label.className = "mb-2 text-xs leading-snug text-slate-700";
    label.textContent = "Preparing upload…";

    const track = document.createElement("div");
    track.className =
      "h-2.5 overflow-hidden rounded-full bg-emerald-100 ring-1 ring-emerald-200/60";

    const bar = document.createElement("div");
    bar.id = "upload-progress-bar";
    bar.className =
      "h-full w-0 rounded-full bg-gradient-to-r from-emerald-500 to-emerald-600 transition-[width] duration-300 ease-out";
    track.appendChild(bar);

    const detail = document.createElement("p");
    detail.id = "upload-progress-detail";
    detail.className = "mt-1.5 text-[10px] text-slate-500";

    wrap.appendChild(row);
    wrap.appendChild(label);
    wrap.appendChild(track);
    wrap.appendChild(detail);

    if (el.knowledgeList && el.knowledgeList.parentNode) {
      el.knowledgeList.parentNode.insertBefore(wrap, el.knowledgeList);
    } else {
      anchor.prepend(wrap);
    }

    el.uploadProgressWrap = wrap;
    el.uploadProgressBar = bar;
    el.uploadProgressPct = pct;
    el.uploadProgressLabel = label;
    el.uploadProgressPhase = phase;
    el.uploadProgressDetail = detail;
    return wrap;
  }

  /** @type {{ id: string, title: string, updatedAt: number, messages: { role: string, content: string }[] }[]} */
  let sessions = [];
  let activeId = null;

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_SETTINGS);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s.masterKey) el.masterKey.value = s.masterKey;
      if (s.companyId) el.companyId.value = s.companyId;
    } catch {
      /* ignore */
    }
  }

  function saveSettings() {
    localStorage.setItem(
      STORAGE_SETTINGS,
      JSON.stringify({
        masterKey: el.masterKey.value.trim(),
        companyId: el.companyId.value.trim(),
      })
    );
  }

  function loadSessions() {
    try {
      const raw = localStorage.getItem(STORAGE_SESSIONS);
      sessions = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(sessions)) sessions = [];
    } catch {
      sessions = [];
    }
  }

  function saveSessions() {
    localStorage.setItem(STORAGE_SESSIONS, JSON.stringify(sessions));
  }

  function showToast(msg, isError) {
    el.toast.textContent = msg;
    el.toast.classList.remove("hidden", "bg-emerald-700", "bg-red-700");
    el.toast.classList.add(isError ? "bg-red-700" : "bg-slate-900");
    el.toast.classList.remove("hidden");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.toast.classList.add("hidden"), 4200);
  }

  function getActive() {
    return sessions.find((s) => s.id === activeId) || null;
  }

  function scrollMessagesToBottom() {
    el.messagesScroll.scrollTop = el.messagesScroll.scrollHeight;
  }

  function renderSidebar() {
    el.sidebar.innerHTML = "";
    const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const s of sorted) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "mb-1 flex w-full flex-col rounded-lg px-3 py-2 text-left text-sm transition hover:bg-slate-100 " +
        (s.id === activeId ? "bg-brand-50 ring-1 ring-brand-200" : "");
      btn.innerHTML = `<span class="truncate font-medium text-slate-800">${escapeHtml(
        s.title || "Chat"
      )}</span><span class="text-xs text-slate-400">${formatTime(s.updatedAt)}</span>`;
      btn.addEventListener("click", () => selectSession(s.id));
      el.sidebar.appendChild(btn);
    }
  }

  function formatTime(ts) {
    try {
      return new Date(ts).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function renderMessages() {
    const session = getActive();
    el.messagesList.innerHTML = "";
    if (!session) return;

    el.chatTitle.textContent = session.title || "New conversation";

    for (const m of session.messages) {
      const wrap = document.createElement("div");
      wrap.className = "flex " + (m.role === "user" ? "justify-end" : "justify-start");

      const bubble = document.createElement("div");
      bubble.className =
        "max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm " +
        (m.role === "user"
          ? "bg-brand-600 text-white"
          : "border border-slate-200 bg-white text-slate-800");
      bubble.setAttribute("dir", "auto");
      bubble.textContent = m.content;

      wrap.appendChild(bubble);
      el.messagesList.appendChild(wrap);
    }
    scrollMessagesToBottom();
  }

  function selectSession(id) {
    activeId = id;
    renderSidebar();
    renderMessages();
    hideSources();
  }

  function hideSources() {
    el.sourcesPanel.classList.add("hidden");
    el.sourcesList.innerHTML = "";
  }

  function showSources(sources) {
    el.sourcesList.innerHTML = "";
    if (!sources || !sources.length) {
      el.sourcesPanel.classList.add("hidden");
      return;
    }
    for (const src of sources) {
      const li = document.createElement("li");
      li.className =
        "rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-700";
      const cite = src.citation || "";
      const fname = src.filename ? ` · ${src.filename}` : "";
      const doc = src.document_id ? ` · ${src.document_id}` : "";
      const dist =
        typeof src.distance === "number" ? ` · distance: ${src.distance.toFixed(4)}` : "";
      li.innerHTML = `<span class="font-semibold text-brand-700">${escapeHtml(
        cite
      )}</span>${escapeHtml(fname)}${escapeHtml(doc)}${escapeHtml(dist)}`;
      if (src.child_excerpt) {
        const p = document.createElement("p");
        p.className = "mt-1 line-clamp-2 text-slate-500";
        p.textContent = src.child_excerpt;
        li.appendChild(p);
      }
      el.sourcesList.appendChild(li);
    }
    el.sourcesPanel.classList.remove("hidden");
  }

  function newSession() {
    const id = "chat_" + Date.now();
    sessions.unshift({
      id,
      title: "New conversation",
      updatedAt: Date.now(),
      messages: [],
    });
    activeId = id;
    saveSessions();
    renderSidebar();
    renderMessages();
    hideSources();
  }

  const SSE_CONTROL_TYPES = new Set([
    "sources",
    "meta",
    "done",
    "error",
    "progress",
  ]);

  function stripSseWireNoise(text) {
    return String(text || "")
      .replace(/event:\s*[a-zA-Z0-9_-]+\s*/gi, "")
      .replace(/^data:\s*/gm, "")
      .replace(/^\s*:\s*/gm, "")
      .trim();
  }

  /** Only text meant for the chat bubble — never event names or control frames. */
  function extractTokenText(payload) {
    if (payload == null) return "";

    if (typeof payload === "string") {
      const cleaned = stripSseWireNoise(payload);
      if (!cleaned) return "";
      if (cleaned.startsWith("{") && cleaned.endsWith("}")) {
        try {
          return extractTokenText(JSON.parse(cleaned));
        } catch {
          return "";
        }
      }
      if (/^event:\s*/i.test(cleaned)) return "";
      return cleaned;
    }

    if (typeof payload === "object") {
      const frameType = String(payload.type || "").toLowerCase();
      if (frameType && frameType !== "token" && frameType !== "message") {
        return "";
      }
      if (SSE_CONTROL_TYPES.has(frameType)) return "";
      if (payload.text != null) return String(payload.text);
      if (payload.t != null) return String(payload.t);
      if (payload.answer != null && frameType === "token") {
        return String(payload.answer);
      }
    }
    return "";
  }

  function dispatchSsePayload(payload, handlers, legacyEventName) {
    if (payload == null) return;

    let frame = payload;
    if (typeof frame === "string") {
      const cleaned = stripSseWireNoise(frame);
      if (!cleaned) return;
      try {
        frame = JSON.parse(cleaned);
      } catch {
        const piece = extractTokenText(cleaned);
        if (piece && handlers.token) handlers.token(piece);
        return;
      }
    }

    const type = String(
      frame.type || legacyEventName || "message"
    ).toLowerCase();

    if (type === "token" || type === "message") {
      const piece = extractTokenText(frame);
      if (piece && handlers.token) handlers.token(piece);
      return;
    }

    if ((type === "sources" || type === "meta") && handlers.sources) {
      const list = frame.sources ?? frame.value?.sources ?? frame;
      handlers.sources(Array.isArray(list) ? { sources: list } : list);
      return;
    }

    if (type === "progress" && handlers.progress) {
      handlers.progress(frame);
      return;
    }

    if (type === "done" && handlers.done) {
      handlers.done(frame);
      return;
    }

    if (type === "error") {
      const msg =
        frame.message || frame.error || "Stream failed.";
      if (handlers.error) handlers.error(frame);
      throw new Error(msg);
    }
  }

  function formatProgressLabel(payload) {
    if (!payload || typeof payload !== "object") {
      return String(payload || "Processing…");
    }
    const phase = String(payload.phase || "processing");
    const phaseTitle = phase.charAt(0).toUpperCase() + phase.slice(1);
    const pct = payload.percent != null ? Math.round(payload.percent) : 0;
    const current = payload.current ?? 0;
    const total = payload.total ?? 0;

    if (phase === "embedding" && total > 0) {
      return `Embedding: ${current}/${total} chunks (${pct}%)`;
    }
    if (payload.message) return payload.message;
    return `${phaseTitle}: ${pct}%`;
  }

  function applyUploadProgress(payload) {
    ensureUploadProgressUi();
    const wrap = el.uploadProgressWrap;
    if (!wrap) return;

    const pct = Math.min(
      100,
      Math.max(0, Math.round(payload?.percent != null ? payload.percent : 0))
    );
    const label = formatProgressLabel(payload);
    const phase = String(payload?.phase || "uploading");

    wrap.classList.remove("hidden");
    wrap.style.display = "block";
    wrap.style.opacity = "1";
    wrap.setAttribute("aria-hidden", "false");

    if (el.uploadProgressBar) el.uploadProgressBar.style.width = pct + "%";
    if (el.uploadProgressPct) el.uploadProgressPct.textContent = pct + "%";
    if (el.uploadProgressLabel) el.uploadProgressLabel.textContent = label;
    if (el.uploadProgressPhase) {
      el.uploadProgressPhase.textContent = phase.charAt(0).toUpperCase() + phase.slice(1);
    }
    if (el.uploadProgressDetail) {
      const cur = payload?.current ?? 0;
      const tot = payload?.total ?? 0;
      el.uploadProgressDetail.textContent =
        tot > 0 ? `Chunk ${cur} of ${tot}` : payload?.filename || "";
    }
  }

  function setUploadProgress(percent, message, extra) {
    applyUploadProgress({
      percent,
      message,
      phase: extra?.phase || "uploading",
      current: extra?.current,
      total: extra?.total,
      filename: extra?.filename,
    });
  }

  function hideUploadProgress(delayMs) {
    const wrap = el.uploadProgressWrap;
    if (!wrap) return;
    const wait = typeof delayMs === "number" ? delayMs : 800;
    wrap.style.opacity = "0";
    setTimeout(() => {
      wrap.classList.add("hidden");
      wrap.style.display = "none";
      wrap.setAttribute("aria-hidden", "true");
      if (el.uploadProgressBar) el.uploadProgressBar.style.width = "0%";
      if (el.uploadProgressPct) el.uploadProgressPct.textContent = "0%";
      if (el.uploadProgressLabel) el.uploadProgressLabel.textContent = "Preparing upload…";
      if (el.uploadProgressDetail) el.uploadProgressDetail.textContent = "";
    }, wait);
  }

  async function pollUploadJob(jobId, headers, onUpdate) {
    const url = `/api/documents/upload-status/${encodeURIComponent(jobId)}`;
    for (let i = 0; i < 3600; i++) {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error("Progress poll failed");
      const job = await res.json();
      onUpdate(job);
      if (job.status === "complete" || job.status === "error") return job;
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error("Upload timed out while polling progress");
  }

  /**
   * Parse SSE frames from fetch streaming body (event + data lines).
   */
  async function consumeSseStream(response, handlers) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    function dispatchFrame(raw) {
      const dataLines = [];
      let legacyEvent = "";

      for (const line of raw.split(/\n/)) {
        if (line.startsWith("event:")) {
          legacyEvent = line.slice(6).trim();
          continue;
        }
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      for (const dataStr of dataLines) {
        if (!dataStr) continue;
        let payload;
        try {
          payload = JSON.parse(dataStr);
        } catch {
          payload = dataStr;
        }
        dispatchSsePayload(payload, handlers, legacyEvent);
      }
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep).replace(/\r/g, "");
        buffer = buffer.slice(sep + 2);
        dispatchFrame(frame);
      }
    }
    const tail = buffer.trim();
    if (tail) {
      dispatchFrame(tail.replace(/\r/g, ""));
    }
  }

  async function sendMessage() {
    const text = el.input.value.trim();
    if (!text) return;

    const masterKey = el.masterKey.value.trim();
    const companyId = el.companyId.value.trim();
    if (!masterKey || !companyId) {
      showToast("Set x-master-key and x-company-id in the sidebar.", true);
      return;
    }

    saveSettings();

    let session = getActive();
    if (!session) newSession();
    session = getActive();
    if (!session) return;

    session.messages.push({ role: "user", content: text });
    if (session.title === "New conversation" || session.messages.length <= 2) {
      session.title = text.slice(0, 48) + (text.length > 48 ? "…" : "");
    }
    session.updatedAt = Date.now();
    saveSessions();

    el.input.value = "";
    el.btnSend.disabled = true;
    el.status.classList.remove("hidden");
    el.status.textContent = "Streaming…";
    hideSources();

    renderSidebar();
    renderMessages();

    const assistantBubble = document.createElement("div");
    assistantBubble.className =
      "max-w-[85%] rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm leading-relaxed text-slate-800 shadow-sm";
    assistantBubble.setAttribute("dir", "auto");

    const row = document.createElement("div");
    row.className = "flex justify-start";
    row.appendChild(assistantBubble);
    el.messagesList.appendChild(row);
    scrollMessagesToBottom();

    let accumulated = "";

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "x-master-key": masterKey,
          "x-company-id": companyId,
        },
        body: JSON.stringify({ question: text, top_k: 3 }),
      });

      const ctype = res.headers.get("content-type") || "";
      if (!res.ok) {
        const errBody = await res.text();
        let msg = errBody || res.statusText;
        try {
          const j = JSON.parse(errBody);
          msg = j.error || j.details || msg;
        } catch {
          /* plain text */
        }
        throw new Error(msg);
      }

      if (!res.body || !ctype.includes("text/event-stream")) {
        throw new Error("Expected text/event-stream from /api/chat");
      }

      await consumeSseStream(res, {
        meta() {
          /* optional; primary UI uses `sources` */
        },
        sources(payload) {
          const list = payload && payload.sources ? payload.sources : payload;
          if (Array.isArray(list)) showSources(list);
        },
        token(piece) {
          const text = extractTokenText(piece);
          if (!text) return;
          accumulated += text;
          assistantBubble.textContent = accumulated;
          scrollMessagesToBottom();
        },
        done(payload) {
          if (payload && Array.isArray(payload.sources)) {
            showSources(payload.sources);
          }
          if (payload && payload.answer) {
            accumulated = stripSseWireNoise(payload.answer);
            assistantBubble.textContent = accumulated;
          }
        },
        error() {
          /* handled by throw in dispatchFrame */
        },
      });

      session.messages.push({ role: "assistant", content: accumulated });
      session.updatedAt = Date.now();
      saveSessions();
      renderSidebar();

      el.status.textContent = "Ready";
    } catch (e) {
      assistantBubble.classList.add("border-red-200", "bg-red-50", "text-red-800");
      assistantBubble.textContent = "Error: " + (e.message || String(e));
      showToast(e.message || "Request failed", true);
      el.status.textContent = "Error";
    } finally {
      el.btnSend.disabled = false;
      setTimeout(() => el.status.classList.add("hidden"), 2000);
    }
  }

  el.btnNew.addEventListener("click", () => newSession());
  el.btnSend.addEventListener("click", sendMessage);
  el.input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      sendMessage();
    }
  });
  function authHeaders() {
    const masterKey = el.masterKey.value.trim();
    const companyId = el.companyId.value.trim();
    return { masterKey, companyId };
  }

  async function loadKnowledgeList() {
    if (!el.knowledgeList) return;
    const { masterKey, companyId } = authHeaders();
    if (!masterKey || !companyId) {
      el.knowledgeList.innerHTML =
        '<p class="text-center text-amber-600">أدخل x-master-key و x-company-id أولاً</p>';
      return;
    }

    el.knowledgeList.innerHTML = '<p class="text-center text-slate-400">جاري تحميل الملفات…</p>';

    try {
      const res = await fetch(`/api/documents?company_id=${encodeURIComponent(companyId)}`, {
        headers: {
          "x-master-key": masterKey,
          "x-company-id": companyId,
        },
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      const docs = await res.json();
      if (!docs.length) {
        el.knowledgeList.innerHTML =
          '<p class="text-center text-slate-400">لا توجد ملفات مرفوعة</p>';
        return;
      }

      el.knowledgeList.innerHTML = "";
      for (const doc of docs) {
        const row = document.createElement("div");
        row.className =
          "flex items-center justify-between gap-2 rounded-md bg-slate-50 px-2 py-2 ring-1 ring-slate-100";
        const date = doc.created_at
          ? new Date(doc.created_at).toLocaleDateString("ar-SA")
          : "";
        row.innerHTML = `
          <div class="min-w-0 flex-1">
            <p class="truncate font-medium text-slate-700">📄 ${escapeHtml(doc.filename)}</p>
            <p class="text-[10px] text-slate-400">${escapeHtml(date)} · ${doc.vector_count || 0} chunks</p>
          </div>
          <button type="button" class="shrink-0 rounded bg-red-500 px-2 py-1 text-[10px] text-white hover:bg-red-600" title="حذف">🗑️</button>
        `;
        row.querySelector("button").addEventListener("click", () =>
          deleteKnowledgeDocument(doc.id, doc.filename)
        );
        el.knowledgeList.appendChild(row);
      }
    } catch (err) {
      el.knowledgeList.innerHTML = `<p class="text-center text-red-600">خطأ: ${escapeHtml(err.message || String(err))}</p>`;
    }
  }

  async function deleteKnowledgeDocument(docId, filename) {
    const { masterKey, companyId } = authHeaders();
    if (!confirm(`هل أنت متأكد من حذف "${filename}"؟`)) return;

    try {
      const res = await fetch(
        `/api/documents/${encodeURIComponent(docId)}?company_id=${encodeURIComponent(companyId)}`,
        {
          method: "DELETE",
          headers: {
            "x-master-key": masterKey,
            "x-company-id": companyId,
          },
        }
      );
      if (!res.ok) throw new Error(await res.text());
      showToast(`تم حذف ${filename}`);
      loadKnowledgeList();
    } catch (err) {
      showToast(err.message || "فشل الحذف", true);
    }
  }

  if (el.uploadKnowledgeBtn && el.knowledgeFileInput) {
    el.uploadKnowledgeBtn.addEventListener("click", () => el.knowledgeFileInput.click());

    el.knowledgeFileInput.addEventListener("change", async (ev) => {
      const files = ev.target.files;
      if (!files || !files.length) return;

      const { masterKey, companyId } = authHeaders();
      if (!masterKey || !companyId) {
        showToast("Set x-master-key and x-company-id first.", true);
        return;
      }

      el.uploadKnowledgeBtn.disabled = true;
      const uploadHeaders = {
        "x-master-key": masterKey,
        "x-company-id": companyId,
      };

      for (const file of files) {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("company_id", companyId);

        ensureUploadProgressUi();
        setUploadProgress(0, `Uploading ${file.name}…`, {
          phase: "received",
          filename: file.name,
        });

        if (el.knowledgeList) {
          el.knowledgeList.innerHTML =
            '<p class="text-center text-emerald-600 py-2">Indexing in progress…</p>';
        }

        try {
          const res = await fetch("/api/documents?stream=sse", {
            method: "POST",
            headers: {
              ...uploadHeaders,
              Accept: "text/event-stream",
            },
            body: formData,
          });

          const ctype = res.headers.get("content-type") || "";

          if (!res.ok) {
            const errText = await res.text();
            throw new Error(errText.slice(0, 200) || res.statusText);
          }

          if (res.body && ctype.includes("text/event-stream")) {
            await consumeSseStream(res, {
              progress(payload) {
                applyUploadProgress({ ...payload, filename: file.name });
              },
              done() {
                applyUploadProgress({
                  phase: "complete",
                  percent: 100,
                  message: "Complete",
                  filename: file.name,
                });
                showToast(`✅ ${file.name}`);
              },
              error(payload) {
                throw new Error(
                  (payload && payload.message) || "Upload failed"
                );
              },
            });
          } else {
            const data = await res.json();
            if (data.job_id) {
              await pollUploadJob(data.job_id, uploadHeaders, (job) => {
                applyUploadProgress({
                  phase: job.phase,
                  percent: job.percent,
                  current: job.current,
                  total: job.total,
                  message: job.message,
                  filename: file.name,
                });
              });
            } else {
              applyUploadProgress({
                phase: "complete",
                percent: 100,
                message: "Complete",
                filename: file.name,
              });
            }
            showToast(`✅ ${data.filename || file.name}`);
          }
        } catch (err) {
          hideUploadProgress(0);
          showToast(`❌ ${file.name}: ${err.message}`, true);
        }
      }

      el.uploadKnowledgeBtn.disabled = false;
      el.uploadKnowledgeBtn.textContent = "⬆️ رفع مستند جديد";
      el.knowledgeFileInput.value = "";
      hideUploadProgress(600);
      loadKnowledgeList();
    });
  }

  el.masterKey.addEventListener("change", () => {
    saveSettings();
    loadKnowledgeList();
  });
  el.companyId.addEventListener("change", () => {
    saveSettings();
    loadKnowledgeList();
  });

  ensureUploadProgressUi();

  loadSettings();
  loadSessions();
  if (sessions.length === 0) newSession();
  else {
    activeId = sessions[0].id;
  }
  renderSidebar();
  renderMessages();
  loadKnowledgeList();
})();
