// 老师会话工作台（T-23）：待接管队列、接管/结束接管、给已接管的会话发消息。
// 授权与状态机全在 education-api（唯一索引 + 带条件 UPDATE + FOR SHARE），这里只负责调用和如实展示冲突，
// 不在前端重新判断一遍"能不能接管"——跟 TeacherApplicationsPage 是同一个原则。
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import {
  ApiError,
  claimHandoff,
  getTeacherConversationMessages,
  listTeacherHandoffs,
  releaseHandoff,
  teacherSendChatMessage,
} from "./api";
import { useAuth } from "./AuthContext";
import type { ConversationMessage, Handoff } from "./types";

const ROLE_LABEL: Record<ConversationMessage["role"], string> = { user: "学员", assistant: "机器人", teacher: "我", system: "系统" };
const QUEUE_POLL_MS = 5000;
const MESSAGES_POLL_MS = 3000;

export function TeacherHandoffsPage() {
  const { user, logout } = useAuth();
  const [handoffs, setHandoffs] = useState<Handoff[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[] | null>(null);
  const [reply, setReply] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const selected = handoffs?.find((h) => h.id === selectedId) ?? null;
  // 只有"当前是我接管的"才能看消息、发消息——排队中的、被别的老师接管的，后端也会拒绝（这里提前不显示，减少无意义的失败请求）。
  const mine = selected?.status === "claimed" && selected.teacherId === user?.id;

  function refreshQueue() {
    return listTeacherHandoffs()
      .then(({ items }) => setHandoffs(items))
      .catch(() => setError("加载队列失败"));
  }

  function loadMessages(conversationId: string) {
    return getTeacherConversationMessages(conversationId)
      .then(({ items }) => setMessages(items))
      .catch(() => setError("加载消息失败"));
  }

  useEffect(() => {
    void refreshQueue();
    // 队列是"新的接管请求什么时候出现"的唯一入口，没有别的信号能告诉这个页面——轮询而不是推送，见 useChat.ts 里同样的注释。
    const timer = setInterval(() => {
      if (!busyRef.current) void refreshQueue();
    }, QUEUE_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selected || !mine) {
      setMessages(null);
      return;
    }
    const conversationId = selected.conversationId;
    void loadMessages(conversationId);
    // 接管期间学员随时可能再发言：这条连接不是持续打开的 SSE，看不到"学员又发了一句"，只能定期自己去查。
    const timer = setInterval(() => {
      if (!busyRef.current) void loadMessages(conversationId);
    }, MESSAGES_POLL_MS);
    return () => clearInterval(timer);
    // selected 对象本身在每次 refreshQueue 后都会是新引用，这里用 conversationId 判断是否要重新加载，避免刷新队列时闪一下空白。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.conversationId, mine]);

  async function afterAction(promise: Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await promise;
      await refreshQueue();
    } catch (err) {
      if (err instanceof ApiError && (err.code === "INVALID_STATE" || err.code === "REVISION_CONFLICT")) {
        setError("这条记录的状态已经变了（可能被别的老师接管，或已经结束），已刷新为最新列表，请核对后重试。");
        await refreshQueue();
      } else {
        setError(err instanceof ApiError ? `操作失败（${err.code}）` : "操作失败，请检查网络后重试。");
      }
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const text = reply.trim();
    if (!selected || !text) return;
    setBusy(true);
    setError(null);
    try {
      const sent = await teacherSendChatMessage(selected.conversationId, { clientMessageId: crypto.randomUUID(), text });
      setMessages((prev) => [...(prev ?? []), sent]);
      setReply("");
    } catch (err) {
      setError(err instanceof ApiError ? `发送失败（${err.code}）` : "发送失败，请检查网络后重试。");
    } finally {
      setBusy(false);
    }
  }

  const queued = handoffs?.filter((h) => h.status === "queued") ?? [];
  const myClaimed = handoffs?.filter((h) => h.status === "claimed" && h.teacherId === user?.id) ?? [];
  const othersClaimed = handoffs?.filter((h) => h.status === "claimed" && h.teacherId !== user?.id) ?? [];

  return (
    <div className="min-h-screen bg-surface text-on-surface p-8 max-w-container-max-width mx-auto">
      <header className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <h1 className="text-headline-sm">会话工作台</h1>
          <Link to="/teacher" className="text-sm text-primary underline">
            申请审批
          </Link>
        </div>
        <div className="flex items-center gap-3 text-sm text-on-surface-variant">
          <span>{user?.loginName}</span>
          <button onClick={() => void logout()} className="text-primary underline">
            退出登录
          </button>
        </div>
      </header>

      {error && <p className="text-error mb-4">{error}</p>}

      <div className="grid grid-cols-[360px_1fr] gap-6">
        <div className="flex flex-col gap-6">
          <HandoffGroup
            title={`待接管（${queued.length}）`}
            items={queued}
            selectedId={selectedId}
            onSelect={setSelectedId}
            action={(h) => (
              <button
                onClick={() => void afterAction(claimHandoff(h.id, { expectedRevision: h.revision }))}
                disabled={busy}
                className="rounded-md bg-primary text-on-primary px-2 py-1 text-xs disabled:opacity-50"
              >
                接管
              </button>
            )}
          />
          <HandoffGroup title={`我接管的（${myClaimed.length}）`} items={myClaimed} selectedId={selectedId} onSelect={setSelectedId} />
          <HandoffGroup title={`其他老师接管中（${othersClaimed.length}）`} items={othersClaimed} selectedId={selectedId} onSelect={setSelectedId} />
        </div>

        <div>
          {!selected ? (
            <p className="text-on-surface-variant">从左侧选一条会话查看。</p>
          ) : !mine ? (
            <div className="rounded-md border border-outline-variant p-4">
              <p className="text-sm text-on-surface-variant">
                {selected.status === "queued" ? "这条还在排队，接管之后才能看到对话内容和发消息。" : "这条正被另一位老师接管，看不到对话内容。"}
              </p>
              {selected.reason && <p className="text-sm text-on-surface-variant mt-2">学员填写的原因：{selected.reason}</p>}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {selected.summary && (
                <div className="rounded-md border border-outline-variant p-4">
                  <p className="text-label-md font-semibold mb-1">交接摘要</p>
                  <pre className="text-sm text-on-surface-variant whitespace-pre-wrap font-sans">{selected.summary}</pre>
                </div>
              )}

              <div className="rounded-md border border-outline-variant p-4 flex flex-col gap-2 max-h-[50vh] overflow-y-auto">
                {messages === null ? (
                  <p className="text-on-surface-variant text-sm">加载中…</p>
                ) : messages.length === 0 ? (
                  <p className="text-on-surface-variant text-sm">还没有消息。</p>
                ) : (
                  messages.map((m) => (
                    <div key={m.id} className="text-sm">
                      <span className="text-on-surface-variant">{ROLE_LABEL[m.role]}：</span>
                      <span>{m.content}</span>
                    </div>
                  ))
                )}
              </div>

              <div className="flex gap-2">
                <input
                  className="flex-1 rounded border border-outline-variant px-2 py-1 text-sm"
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void send();
                  }}
                  placeholder="回复学员…"
                  disabled={busy}
                />
                <button onClick={() => void send()} disabled={busy || !reply.trim()} className="rounded-md bg-primary text-on-primary px-3 py-1.5 text-sm disabled:opacity-50">
                  发送
                </button>
              </div>

              <button
                onClick={() => void afterAction(releaseHandoff(selected.id, { expectedRevision: selected.revision }))}
                disabled={busy}
                className="self-start rounded-md border border-outline-variant px-3 py-1.5 text-sm disabled:opacity-50"
              >
                结束接管（会话交还机器人）
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function HandoffGroup({
  title,
  items,
  selectedId,
  onSelect,
  action,
}: {
  title: string;
  items: Handoff[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  action?: (h: Handoff) => ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-label-sm text-on-surface-variant mb-2">{title}</p>
      <ul className="flex flex-col gap-2">
        {items.map((h) => (
          <li key={h.id} className="flex items-center gap-2">
            <button
              onClick={() => onSelect(h.id)}
              className={`flex-1 text-left rounded-md border px-3 py-2 text-sm truncate ${
                h.id === selectedId ? "border-primary bg-primary-container/10" : "border-outline-variant"
              }`}
            >
              {h.reason || "（学员未填写原因）"}
            </button>
            {action?.(h)}
          </li>
        ))}
      </ul>
    </div>
  );
}
