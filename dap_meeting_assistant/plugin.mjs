/**
 * Meeting Assistant — external DAP plugin for live meeting assistance.
 *
 * host meeting capture(whisper STT)의 final transcript를 받아
 *  1) 라이브 패널에 원문 표시 + 실시간 번역(Google 무료 엔드포인트, ~0.3s)을 뒤따라 붙이고
 *  2) 요청 시 최근 맥락으로 답변 초안(동의/반박/질문/제안)을 만들고
 *  3) 종료 시 회의 리포트(요약·결정·액션아이템·내 발화 개선)를 생성·보관한다.
 *
 * LLM(구독 CLI, 콜당 수십 초)은 답변 추천·요약·리포트 전용이고 하나의 직렬 큐를 지난다.
 * 실시간 번역을 LLM에 태우면 큐가 밀려 답변 추천까지 느려지므로 번역은 LLM을 쓰지 않는다.
 */
export function activate(ctx) {
  let palette = null;
  let offStatus = null;
  let offTranscript = null;
  let running = false;
  let sessionId = null;
  let startedAt = 0;
  let lines = []; // { id, speaker: "me"|"peer", text, ts, translation? }
  let nextLineId = 1;
  let pendingTranslation = [];
  let translating = false;

  const settingsValues = () => {
    const v = ctx.host.settings?.values("general") ?? {};
    return {
      sourceLanguage: typeof v.sourceLanguage === "string" ? v.sourceLanguage : "auto",
      targetLanguage: typeof v.targetLanguage === "string" ? v.targetLanguage : "ko",
      // 출력 언어 = 예상 답변(답변 초안)을 생성할 언어. "auto"면 회의 언어를 따라간다 —
      // 언어가 다른 상대와의 화상 회의에서 상대 언어로 바로 말할 수 있게 하는 목적.
      replyLanguage: typeof v.replyLanguage === "string" ? v.replyLanguage : "auto",
      // 기본 ON — 번역이 무료 웹 엔드포인트로 옮겨져 LLM 큐·구독 한도를 쓰지 않는다.
      autoTranslate: v.autoTranslate !== false,
    };
  };

  const LANG_NAMES = { en: "영어", ko: "한국어", ja: "일본어", zh: "중국어" };

  ctx.settings.registerSettingsSection({
    sectionId: "general",
    title: "회의 어시스턴트",
    spec: {
      fields: [
        {
          key: "sourceLanguage",
          label: "회의 언어(음성 인식)",
          type: "select",
          default: "auto",
          options: [
            { value: "auto", label: "자동 감지" },
            { value: "en", label: "영어" },
            { value: "ko", label: "한국어" },
            { value: "ja", label: "일본어" },
            { value: "zh", label: "중국어" },
          ],
        },
        {
          key: "targetLanguage",
          label: "번역 언어(전사 자막)",
          type: "select",
          default: "ko",
          options: [
            { value: "ko", label: "한국어" },
            { value: "en", label: "영어" },
            { value: "ja", label: "일본어" },
            { value: "zh", label: "중국어" },
          ],
        },
        {
          key: "replyLanguage",
          label: "출력 언어(예상 답변)",
          type: "select",
          default: "auto",
          options: [
            { value: "auto", label: "자동 (회의 언어)" },
            { value: "en", label: "영어" },
            { value: "ko", label: "한국어" },
            { value: "ja", label: "일본어" },
            { value: "zh", label: "중국어" },
          ],
        },
        { key: "autoTranslate", label: "실시간 번역", type: "toggle", default: true },
      ],
    },
  });

  // ---- serial LLM queue ------------------------------------------------
  let llmQueue = Promise.resolve();
  const llm = (prompt, timeoutS) =>
    new Promise((resolve, reject) => {
      llmQueue = llmQueue
        .then(() => ctx.host.llm.generate(prompt, timeoutS ?? 60))
        .then(resolve, reject);
    });

  const post = (msg) => {
    if (palette && !palette.isDestroyed()) palette.postMessage(msg);
  };

  // ---- live translation (Google 무료 엔드포인트, ~0.3s/콜) -----------------
  // 구독 CLI LLM(콜당 수십 초)은 라이브 자막에 못 쓴다. keyless 웹 번역으로 즉시 붙이고,
  // 감지된 원문 언어가 번역 언어와 같으면 표시하지 않는다 (auto 모드 한국어 재번역 방지).
  const googleTranslate = async (text, target) => {
    const url =
      "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto" +
      `&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`translate HTTP ${res.status}`);
    const body = await res.json();
    const detected = typeof body?.[2] === "string" ? body[2] : "";
    const translated = Array.isArray(body?.[0])
      ? body[0].map((seg) => (Array.isArray(seg) ? String(seg[0] ?? "") : "")).join("").trim()
      : "";
    return { translated, detected };
  };

  const scheduleTranslate = () => {
    if (translating || pendingTranslation.length === 0) return;
    translating = true;
    const line = pendingTranslation.shift();
    const { targetLanguage } = settingsValues();
    googleTranslate(line.text, targetLanguage)
      .then(({ translated, detected }) => {
        // 원문이 이미 번역 언어면 붙이지 않는다 (ko 발화를 ko로 "재번역"하는 낭비 방지).
        if (!translated || (detected && detected === targetLanguage)) return;
        line.translation = translated;
        post({ type: "translation", id: line.id, text: translated });
      })
      .catch(() => {
        /* 번역은 best-effort — 원문은 이미 표시됨 */
      })
      .finally(() => {
        translating = false;
        scheduleTranslate();
      });
  };

  // ---- transcript plumbing ----------------------------------------------
  const transcriptText = (max = 6000) => {
    const rows = lines.map((l) => `[${l.speaker === "me" ? "나" : "상대"}] ${l.text}`);
    let text = rows.join("\n");
    while (text.length > max && rows.length > 1) {
      rows.shift();
      text = rows.join("\n");
    }
    return text;
  };

  // ---- session draft (앱 종료·리포트 실패에도 전사를 남긴다) ----------------
  // 리포트는 종료 후 LLM 완료(최대 2분)에 의존한다 — 그 사이 앱이 꺼지면 세션 전체가
  // 사라지므로, 전사를 3초 디바운스로 draft에 계속 저장하고 리포트 성공 시에만 지운다.
  let draftTimer = null;
  const saveDraftNow = async () => {
    if (!ctx.host.storage || !sessionId || lines.length === 0) return;
    const drafts = ((await ctx.host.storage.getJson("drafts")) ?? []).filter((d) => d.id !== sessionId);
    drafts.unshift({
      id: sessionId,
      startedAt,
      lineCount: lines.length,
      title: `미완성 세션 ${new Date(startedAt || Date.now()).toLocaleString("ko-KR")}`,
    });
    await ctx.host.storage.setJson("drafts", drafts.slice(0, 10));
    await ctx.host.storage.setJson(`draft:${sessionId}`, { id: sessionId, startedAt, lines });
  };
  const saveDraftSoon = () => {
    if (draftTimer) return;
    draftTimer = setTimeout(() => {
      draftTimer = null;
      saveDraftNow().catch(() => {});
    }, 3000);
  };
  const removeDraft = async (id) => {
    if (!ctx.host.storage) return;
    const drafts = ((await ctx.host.storage.getJson("drafts")) ?? []).filter((d) => d.id !== id);
    await ctx.host.storage.setJson("drafts", drafts);
    await ctx.host.storage.delete(`draft:${id}`);
  };

  const onTranscript = (event) => {
    if (!event.isFinal) return;
    const line = {
      id: nextLineId++,
      speaker: event.speaker === "me" ? "me" : "peer",
      text: event.text,
      ts: event.timestampMs,
    };
    lines.push(line);
    post({ type: "line", line });
    saveDraftSoon();
    const v = settingsValues();
    if (v.autoTranslate && v.targetLanguage !== event.language) {
      pendingTranslation.push(line);
      scheduleTranslate();
    }
  };

  // ---- meeting session ----------------------------------------------------
  const start = async () => {
    const meeting = ctx.host.meeting;
    if (!meeting) {
      post({ type: "error", message: "meeting.capture 권한이 없어요." });
      return;
    }
    const cap = meeting.capabilities();
    if (!cap.available) {
      const message = cap.reason ?? "회의 캡처를 사용할 수 없어요.";
      ctx.host.bubble.speak(message);
      post({ type: "error", message });
      return;
    }
    const source = cap.sources.includes("both")
      ? "both"
      : cap.sources.includes("system")
        ? "system"
        : "microphone";
    const v = settingsValues();
    lines = [];
    nextLineId = 1;
    pendingTranslation = [];
    post({ type: "reset" });
    try {
      offStatus?.();
      offTranscript?.();
      offStatus = meeting.onStatus((status) => post({ type: "status", status }));
      offTranscript = meeting.onTranscript(onTranscript);
      const status = await meeting.start({
        source,
        sourceLanguage: v.sourceLanguage === "auto" ? undefined : v.sourceLanguage,
        targetLanguage: v.targetLanguage,
      });
      running = true;
      sessionId = status.sessionId ?? String(Date.now());
      startedAt = Date.now();
      post({ type: "status", status });
      // 녹음 알림 (2026-07-27 결정): 시작할 때마다 펫 말풍선으로 상기시키고,
      // 최초 1회는 법적 책임·외부 전송(번역)까지 담은 고지를 패널에 띄운다.
      ctx.host.bubble.speak("회의 캡처 시작! 녹음 사실을 상대방에게 알려주세요 🎙️");
      if (ctx.host.storage && !(await ctx.host.storage.getJson("consentNoticeShown"))) {
        post({
          type: "notice",
          message:
            "🎙️ 처음 한 번 안내드려요 — 이 기능은 회의 음성을 녹음·전사해요. " +
            "지역에 따라 상대방 동의가 필요할 수 있고, 녹음 사실을 알리는 책임은 사용자에게 있어요. " +
            "실시간 번역을 켜면 전사 텍스트가 Google 번역으로 전송돼요.",
        });
        await ctx.host.storage.setJson("consentNoticeShown", true);
      }
      if (source === "microphone") {
        post({
          type: "notice",
          message: "지금은 마이크만 캡처해요 — 상대방 음성(시스템 오디오)은 이 환경에서 사용할 수 없어요.",
        });
      }
    } catch (error) {
      running = false;
      post({ type: "error", message: String(error?.message ?? error) });
    }
  };

  const buildReportFrom = async (reportLines, reportStartedAt, reportId) => {
    const rows = reportLines.map((l) => `[${l.speaker === "me" ? "나" : "상대"}] ${l.text}`);
    let transcript = rows.join("\n");
    while (transcript.length > 6000 && rows.length > 1) {
      rows.shift();
      transcript = rows.join("\n");
    }
    if (!transcript) return null;
    const mine = reportLines.filter((l) => l.speaker === "me");
    const prompt =
      "너는 회의 비서야. 아래 회의 전사로 한국어 리포트를 작성해줘. 형식:\n" +
      "## 요약\n(3~5문장)\n## 결정사항\n(불릿, 없으면 '없음')\n## 액션 아이템\n(불릿, 담당·기한 있으면 표기)\n" +
      (mine.length > 0
        ? "## 내 발화 개선\n([나] 발언 중 최대 3개를 골라 '원문 → 더 나은 표현' 형식으로, 회의 언어 그대로 제안하고 한 줄 해설)\n"
        : "") +
      `\n전사:\n${transcript}`;
    const body = await llm(prompt, 120);
    return {
      id: reportId ?? String(Date.now()),
      createdAt: Date.now(),
      startedAt: reportStartedAt,
      lineCount: reportLines.length,
      title: `회의 리포트 ${new Date(reportStartedAt || Date.now()).toLocaleString("ko-KR")}`,
      body: String(body).trim(),
    };
  };

  const persistReport = async (report) => {
    if (!ctx.host.storage) return;
    const index = ((await ctx.host.storage.getJson("reports")) ?? []).filter((r) => r.id !== report.id);
    index.unshift({ id: report.id, title: report.title, createdAt: report.createdAt });
    await ctx.host.storage.setJson("reports", index.slice(0, 30));
    await ctx.host.storage.setJson(`report:${report.id}`, report);
    await removeDraft(report.id);
  };

  const stop = async () => {
    const meeting = ctx.host.meeting;
    running = false;
    try {
      await meeting?.stop();
    } catch {
      /* 종료 실패해도 리포트는 시도 */
    }
    offStatus?.();
    offTranscript?.();
    offStatus = null;
    offTranscript = null;
    if (lines.length === 0) {
      post({ type: "status", status: { state: "idle" } });
      return;
    }
    // 리포트 LLM(최대 2분)이 도는 동안 앱이 꺼져도 전사가 남도록 draft를 먼저 확정한다.
    if (draftTimer) {
      clearTimeout(draftTimer);
      draftTimer = null;
    }
    await saveDraftNow().catch(() => {});
    post({ type: "reporting" });
    try {
      const report = await buildReportFrom(lines, startedAt, sessionId);
      if (report) await persistReport(report);
      post({ type: "report", report });
      ctx.host.bubble.speak("회의 리포트가 준비됐어!");
    } catch (error) {
      post({
        type: "error",
        message:
          `리포트 생성 실패: ${String(error?.message ?? error)}\n` +
          "전사는 저장돼 있어요 — 리포트 탭의 미완성 세션에서 다시 만들 수 있어요.",
      });
    }
  };

  const regenReport = async (id) => {
    const draft = await ctx.host.storage?.getJson(`draft:${id}`);
    if (!draft || !Array.isArray(draft.lines) || draft.lines.length === 0) {
      post({ type: "error", message: "저장된 전사를 찾을 수 없어요." });
      return;
    }
    post({ type: "reporting" });
    try {
      const report = await buildReportFrom(draft.lines, draft.startedAt, draft.id);
      if (report) await persistReport(report);
      post({ type: "report", report });
    } catch (error) {
      post({ type: "error", message: `리포트 생성 실패: ${String(error?.message ?? error)}` });
    }
  };

  const suggest = async (stance) => {
    const stances = {
      agree: "동의하며 상대 의견을 보강하는",
      counter: "정중하게 반박하며 근거를 드는",
      question: "핵심을 파고드는 질문을 하는",
      propose: "구체적 대안을 제안하는",
    };
    // 짧은 컨텍스트 = 빠른 첫 토큰. 답변 초안은 "직전 맥락"만 있으면 충분하다.
    const transcript = transcriptText(1200);
    if (!transcript) {
      post({ type: "suggestion", stance, error: "아직 전사된 대화가 없어요." });
      return;
    }
    const v = settingsValues();
    // 출력 언어 = 상대에게 바로 말할 문장 언어 (교차 언어 화상회의용). auto면 회의 언어.
    const replyLangLabel =
      v.replyLanguage !== "auto"
        ? LANG_NAMES[v.replyLanguage] ?? v.replyLanguage
        : "회의(상대) 언어";
    // 이해용 보조 번역(SUB) — 전사 자막 언어 설정을 따르고, 답변과 같으면 생략.
    const subLang = LANG_NAMES[v.targetLanguage] ?? "한국어";
    const needSub = v.replyLanguage === "auto" || v.replyLanguage !== v.targetLanguage;
    const prompt =
      `너는 교차 언어 화상회의 비서야. 나는 상대와 다른 언어를 쓸 수 있어.\n` +
      `아래 전사 맥락에 이어 내가 마이크에 바로 말할 ${stances[stance] ?? stances.agree} 답변을 ` +
      `반드시 ${replyLangLabel}로 1~2문장만 써줘. 설명·따옴표·메타멘트 금지.\n` +
      `형식(정확히):\nREPLY: <내가 말할 문장>\n` +
      (needSub ? `SUB: <이해용 ${subLang} 번역 — REPLY가 이미 ${subLang}면 빈 줄>\n` : "") +
      `\n전사:\n${transcript}`;
    try {
      const raw = String(await llm(prompt, 60));
      const reply = raw.match(/REPLY:\s*([\s\S]*?)(?:\nSUB:|$)/)?.[1]?.trim() ?? raw.trim();
      const ko = raw.match(/SUB:\s*([\s\S]*)$/)?.[1]?.trim() ?? "";
      post({ type: "suggestion", stance, reply, ko });
    } catch (error) {
      post({ type: "suggestion", stance, error: String(error?.message ?? error) });
    }
  };

  const summarize = async () => {
    const transcript = transcriptText(5000);
    if (!transcript) {
      post({ type: "summary", error: "아직 전사된 대화가 없어요." });
      return;
    }
    try {
      const text = await llm(`아래 회의 전사를 한국어 2~3문장으로 요약해줘. 요약문만 출력:\n\n${transcript}`, 60);
      post({ type: "summary", text: String(text).trim() });
    } catch (error) {
      post({ type: "summary", error: String(error?.message ?? error) });
    }
  };

  // ---- palette -------------------------------------------------------------
  const open = () => {
    if (palette && !palette.isDestroyed()) {
      palette.toggle();
      return;
    }
    palette = ctx.host.windows.openPalette({
      page: "palette/index.html",
      width: 420,
      height: 640,
      frame: false,
      alwaysOnTop: true,
      visibleOnAllWorkspaces: true,
      level: "pop-up-menu",
    });
    palette.onMessage((msg) => {
      if (msg?.type === "ready") post({ type: "init", running, lines, lang: settingsValues() });
      else if (msg?.type === "setLang") {
        // 팔레트 드롭다운 → 설정 창과 같은 저장소(plugin-settings.json)에 기록해 동기화.
        // 출력 언어(replyLanguage)는 답변 생성 시점에 읽으므로 즉시 적용된다.
        const src = typeof msg.sourceLanguage === "string" ? msg.sourceLanguage : null;
        const reply = typeof msg.replyLanguage === "string" ? msg.replyLanguage : null;
        const prev = settingsValues();
        if (src) ctx.host.settings?.set?.("general", "sourceLanguage", src);
        if (reply) ctx.host.settings?.set?.("general", "replyLanguage", reply);
        if (running && src && src !== prev.sourceLanguage) {
          post({ type: "notice", message: "인식 언어 변경은 다음 세션 시작부터 적용돼요. (출력 언어는 바로 적용)" });
        }
      } else if (msg?.type === "start") void start();
      else if (msg?.type === "stop") void stop();
      else if (msg?.type === "suggest") void suggest(String(msg.stance ?? "agree"));
      else if (msg?.type === "summarize") void summarize();
      else if (msg?.type === "copy" && typeof msg.text === "string") {
        ctx.host.clipboard.writeText(msg.text);
        ctx.host.bubble.speak("복사했어!");
      } else if (msg?.type === "loadReports") {
        void (async () => {
          const index = (await ctx.host.storage?.getJson("reports")) ?? [];
          const drafts = (await ctx.host.storage?.getJson("drafts")) ?? [];
          post({ type: "reports", reports: index, drafts });
        })();
      } else if (msg?.type === "regenReport" && msg.id) {
        void regenReport(String(msg.id));
      } else if (msg?.type === "openReport" && msg.id) {
        void (async () => {
          const report = await ctx.host.storage?.getJson(`report:${msg.id}`);
          if (report) post({ type: "report", report });
        })();
      }
    });
  };

  ctx.actions.registerAction({ id: "openMeetingAssistant", callback: open });
  ctx.radialMenu.addItem({
    itemId: "meeting",
    label: "회의 도우미",
    actionId: "openMeetingAssistant",
    priority: 60,
    icon: "assets/icon.svg",
  });
  ctx.trayMenu.addItem({
    itemId: "open",
    label: "회의 어시스턴트 열기",
    actionId: "openMeetingAssistant",
    showInContextMenu: true,
  });

  return () => {
    offStatus?.();
    offTranscript?.();
    if (draftTimer) {
      clearTimeout(draftTimer);
      draftTimer = null;
      // 비활성화 직전 마지막 전사까지 draft로 남긴다 (best-effort).
      saveDraftNow().catch(() => {});
    }
    if (running) void ctx.host.meeting?.stop();
    if (palette && !palette.isDestroyed()) palette.close();
  };
}
