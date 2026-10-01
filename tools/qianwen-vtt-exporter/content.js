(() => {
  const BUTTON_ID = "qianwen-vtt-export-button";
  const TRANSCRIPT_ITEM_SELECTOR = "[data-transcript-idx]";
  const RECORD_END_FALLBACK_SECONDS = 5;

  function parseTimestamp(value) {
    const parts = value.trim().split(":").map(Number);
    if (parts.length === 2 && parts.every(Number.isFinite)) {
      return parts[0] * 60 + parts[1];
    }
    if (parts.length === 3 && parts.every(Number.isFinite)) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    throw new Error(`无法识别时间戳：${value}`);
  }

  function formatTimestamp(totalSeconds) {
    const roundedMilliseconds = Math.round(totalSeconds * 1000);
    const hours = Math.floor(roundedMilliseconds / 3_600_000);
    const minutes = Math.floor((roundedMilliseconds % 3_600_000) / 60_000);
    const seconds = Math.floor((roundedMilliseconds % 60_000) / 1000);
    const milliseconds = roundedMilliseconds % 1000;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
  }

  function readCues() {
    const cues = [...document.querySelectorAll(TRANSCRIPT_ITEM_SELECTOR)].map((item) => {
      const time = item.querySelector('[class*="segmentTime"]')?.textContent?.trim();
      const speaker = item.querySelector('[class*="editableSpeaker"]')?.textContent?.trim() || "发言人";
      const text = item.querySelector('[class*="transcriptContent"]')?.textContent?.replace(/\s+/g, " ").trim();
      return time && text ? { start: parseTimestamp(time), speaker, text } : null;
    }).filter(Boolean);

    if (!cues.length) {
      throw new Error("没有找到转写内容。请确认当前打开的是千问录音纪要分享页，并已切换到“转写”。");
    }
    for (let index = 1; index < cues.length; index += 1) {
      if (cues[index].start <= cues[index - 1].start) {
        throw new Error(`第 ${index + 1} 段时间没有递增，已停止导出。`);
      }
    }
    return cues;
  }

  function readRecordingDuration(lastCueStart) {
    const audioDuration = document.querySelector("audio")?.duration;
    if (Number.isFinite(audioDuration) && audioDuration > lastCueStart) {
      return audioDuration;
    }

    const playerTime = document.body.innerText.match(/(?:\d+:)?\d{1,2}:\d{2}\s*\/\s*((?:\d+:)?\d{1,2}:\d{2})/);
    if (playerTime) {
      const duration = parseTimestamp(playerTime[1]);
      if (duration > lastCueStart) return duration;
    }

    return lastCueStart + RECORD_END_FALLBACK_SECONDS;
  }

  function escapeVoiceName(value) {
    return value.replace(/[<>\n\r]/g, "").trim() || "发言人";
  }

  function buildVtt(cues) {
    const duration = readRecordingDuration(cues.at(-1).start);
    const title = document.querySelector("h1")?.textContent?.trim() || document.title || "千问录音纪要";
    const lines = [
      "WEBVTT",
      "",
      `NOTE 来源：${location.href}`,
      `NOTE 标题：${title}`,
      "",
    ];

    cues.forEach((cue, index) => {
      const end = cues[index + 1]?.start ?? duration;
      lines.push(
        String(index + 1),
        `${formatTimestamp(cue.start)} --> ${formatTimestamp(end)}`,
        `<v ${escapeVoiceName(cue.speaker)}>${cue.text}`,
        "",
      );
    });
    return `${lines.join("\n")}\n`;
  }

  function suggestedFilename() {
    const title = document.querySelector("h1")?.textContent?.trim() || document.title || "qianwen-record";
    const safeTitle = title.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
    return `${safeTitle || "qianwen-record"}.vtt`;
  }

  async function saveVtt(content) {
    const url = URL.createObjectURL(new Blob([content], { type: "text/vtt;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = suggestedFilename();
    link.hidden = true;
    document.documentElement.appendChild(link);
    link.click();
    setTimeout(() => {
      link.remove();
      URL.revokeObjectURL(url);
    }, 1000);
    return "downloaded";
  }

  async function exportTranscript(button) {
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "正在生成…";
    try {
      const cues = readCues();
      const saveMode = await saveVtt(buildVtt(cues));
      button.textContent = saveMode === "downloaded" ? `已下载 ${cues.length} 段` : `已导出 ${cues.length} 段`;
      console.info(`[千问录音转 VTT] 已生成 ${cues.length} 段。`);
    } catch (error) {
      if (error?.name !== "AbortError") {
        alert(`VTT 导出失败：${error instanceof Error ? error.message : String(error)}`);
      }
      button.textContent = originalText;
    } finally {
      button.disabled = false;
      setTimeout(() => {
        button.textContent = originalText;
      }, 2500);
    }
  }

  function mountButton() {
    if (document.getElementById(BUTTON_ID)) return;
    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.textContent = "导出 VTT";
    Object.assign(button.style, {
      position: "fixed",
      right: "20px",
      bottom: "20px",
      zIndex: "2147483647",
      padding: "10px 16px",
      border: "0",
      borderRadius: "8px",
      background: "#1677ff",
      color: "white",
      fontSize: "14px",
      fontWeight: "600",
      boxShadow: "0 4px 16px rgba(0, 0, 0, 0.2)",
      cursor: "pointer",
    });
    button.addEventListener("click", () => exportTranscript(button));
    document.documentElement.appendChild(button);
  }

  mountButton();
  new MutationObserver(mountButton).observe(document.documentElement, { childList: true, subtree: true });
})();
