// 老师会话工作台（T-23）：待接管队列、接管/结束接管、给已接管的会话发消息。
// 授权与状态机全在 education-api（唯一索引 + 带条件 UPDATE + FOR SHARE），这里只负责调用和如实展示冲突，
// 不在前端重新判断一遍"能不能接管"——跟 TeacherApplicationsPage 是同一个原则。
// 身份、导航（申请审批/退出）由外层 TeacherLayout 的侧栏提供，这里只管内容。
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../components/ui/Icon";
import { ApiError, claimHandoff, getTeacherConversationMessages, listTeacherHandoffs, releaseHandoff, teacherSendChatMessage } from "./api";
import { useAuth } from "./AuthContext";
import type { ConversationMessage, Handoff } from "./types";

const QUEUE_POLL_MS = 5000;
const MESSAGES_POLL_MS = 3000;

export function TeacherHandoffsPage() {
  const { user } = useAuth();
  const [handoffs, setHandoffs] = useState<Handoff[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[] | null>(null);
  const [reply, setReply] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  // 查询与发送共享编号：新请求、切换会话或卸载后，旧响应不再有权修改消息区。
  const messageRequest = useRef(0);

  const selected = handoffs?.find((h) => h.id === selectedId) ?? null;
  // 只有"当前是我接管的"才能看消息、发消息——排队中的、被别的老师接管的，后端也会拒绝（这里提前不显示，减少无意义的失败请求）。
  const mine = selected?.status === "claimed" && selected.teacherId === user?.id;

  function refreshQueue() {
    return listTeacherHandoffs()
      .then(({ items }) => setHandoffs(items))
      .catch(() => setError("加载队列失败"));
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
    let active = true;
    setMessages(null);
    if (!selected || !mine) {
      return;
    }
    const conversationId = selected.conversationId;
    async function loadMessages() {
      const requestId = ++messageRequest.current;
      try {
        const { items } = await getTeacherConversationMessages(conversationId);
        if (active && requestId === messageRequest.current) setMessages(items);
      } catch {
        if (active && requestId === messageRequest.current) setError("加载消息失败");
      }
    }
    void loadMessages();
    // 接管期间学员随时可能再发言：这条连接不是持续打开的 SSE，看不到"学员又发了一句"，只能定期自己去查。
    const timer = setInterval(() => {
      if (!busyRef.current) void loadMessages();
    }, MESSAGES_POLL_MS);
    return () => {
      active = false;
      messageRequest.current++;
      clearInterval(timer);
    };
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
    if (!selected || !mine || !text || busyRef.current) return;
    const requestId = ++messageRequest.current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const sent = await teacherSendChatMessage(selected.conversationId, { clientMessageId: crypto.randomUUID(), text });
      if (requestId !== messageRequest.current) return;
      setMessages((prev) => [...(prev ?? []), sent]);
      setReply("");
    } catch (err) {
      if (requestId === messageRequest.current) setError(err instanceof ApiError ? `发送失败（${err.code}）` : "发送失败，请检查网络后重试。");
    } finally {
      setBusy(false);
    }
  }

  const queued = handoffs?.filter((h) => h.status === "queued") ?? [];
  const myClaimed = handoffs?.filter((h) => h.status === "claimed" && h.teacherId === user?.id) ?? [];
  const othersClaimed = handoffs?.filter((h) => h.status === "claimed" && h.teacherId !== user?.id) ?? [];

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center justify-between h-16 px-gutter border-b border-outline-variant bg-surface shrink-0">
        <h1 className="text-headline-sm font-semibold text-on-surface">会话工作台</h1>
        {handoffs && (
          <span className="text-label-sm text-on-surface-variant">
            {queued.length > 0 ? `${queued.length} 条待接管` : "队列已清空"}
          </span>
        )}
      </header>

      {error && (
        <p role="status" className="text-body-sm text-error px-gutter pt-3">
          {error}
        </p>
      )}

      <div className="flex-1 min-h-0 flex">
        <div className="w-[320px] shrink-0 border-r border-outline-variant h-full overflow-y-auto custom-scrollbar py-4">
          {handoffs === null ? (
            <p className="px-4 text-body-sm text-on-surface-variant">加载中…</p>
          ) : handoffs.length === 0 ? (
            <p className="px-4 text-body-sm text-outline italic">没有进行中的会话。</p>
          ) : (
            <div className="flex flex-col gap-5">
              <HandoffGroup
                title="待接管"
                items={queued}
                selectedId={selectedId}
                onSelect={setSelectedId}
                action={(h) => (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void afterAction(claimHandoff(h.id, { expectedRevision: h.revision }));
                    }}
                    disabled={busy}
                    className="shrink-0 rounded-lg bg-primary text-on-primary px-2.5 py-1 text-label-sm hover:opacity-90 disabled:opacity-50"
                  >
                    接管
                  </button>
                )}
              />
              <HandoffGroup title="我接管的" items={myClaimed} selectedId={selectedId} onSelect={setSelectedId} tone="mine" />
              <HandoffGroup title="其他老师接管中" items={othersClaimed} selectedId={selectedId} onSelect={setSelectedId} tone="muted" />
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0 h-full">
          {!selected ? (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-on-surface-variant">
              <Icon name="forum" className="text-[40px] text-outline" />
              <p className="text-body-sm">从左侧选一条会话查看</p>
            </div>
          ) : !mine ? (
            <div className="h-full flex flex-col items-center justify-center gap-3 px-8 text-center">
              <Icon name={selected.status === "queued" ? "hourglass_top" : "lock"} className="text-[32px] text-outline" />
              <p className="text-body-sm text-on-surface-variant max-w-sm">
                {selected.status === "queued" ? "这条还在排队，接管之后才能看到对话内容和发消息。" : "这条正被另一位老师接管，看不到对话内容。"}
              </p>
              {selected.reason && <p className="text-body-sm text-on-surface-variant">学员填写的原因：{selected.reason}</p>}
            </div>
          ) : (
            <div className="h-full flex flex-col">
              {selected.summary && (
                <div className="mx-4 mt-4 rounded-xl border border-secondary-container bg-secondary-container/20 p-3">
                  <p className="text-label-sm font-semibold text-on-secondary-container mb-1 flex items-center gap-1.5">
                    <Icon name="summarize" className="text-[16px]" />
                    交接摘要
                  </p>
                  <pre className="text-label-sm text-on-surface-variant whitespace-pre-wrap font-sans leading-relaxed">{selected.summary}</pre>
                </div>
              )}

              <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 py-4 flex flex-col gap-3">
                {messages === null ? (
                  <p className="text-body-sm text-on-surface-variant">加载中…</p>
                ) : messages.length === 0 ? (
                  <p className="text-body-sm text-on-surface-variant">还没有消息。</p>
                ) : (
                  messages.map((m) => <TeacherViewBubble key={m.id} message={m} />)
                )}
              </div>

              <div className="px-4 pb-3 flex items-center gap-2">
                <input
                  className="flex-1 rounded-xl border border-outline-variant bg-surface-container-lowest px-3 py-2 text-body-sm focus:outline-none focus:border-primary"
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void send();
                  }}
                  placeholder="回复学员…"
                  disabled={busy}
                />
                <button
                  onClick={() => void send()}
                  disabled={busy || !reply.trim()}
                  className="h-10 w-10 shrink-0 rounded-lg flex items-center justify-center bg-primary text-on-primary disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Icon name="send" filled />
                </button>
              </div>

              <div className="px-4 pb-4">
                <button
                  onClick={() => void afterAction(releaseHandoff(selected.id, { expectedRevision: selected.revision }))}
                  disabled={busy}
                  className="w-full flex items-center justify-center gap-1.5 rounded-lg border border-outline-variant px-3 py-2 text-label-md text-on-surface-variant hover:bg-surface-container-low disabled:opacity-50"
                >
                  <Icon name="logout" className="text-[16px]" />
                  结束接管，会话交还机器人
                </button>
              </div>
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
  tone = "queued",
}: {
  title: string;
  items: Handoff[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  action?: (h: Handoff) => ReactNode;
  tone?: "queued" | "mine" | "muted";
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-label-sm font-semibold text-outline uppercase tracking-wider px-4 mb-1.5">
        {title}（{items.length}）
      </p>
      <ul className="flex flex-col gap-1 px-2">
        {items.map((h) => {
          const active = h.id === selectedId;
          // 选中的按钮和"接管"按钮是并列的两个 <button>，不能把后者嵌进前者——按钮不能嵌套按钮（无效 HTML，React 会报水合错误）。
          return (
            <li key={h.id} className={`flex items-center gap-1 rounded-lg transition-colors ${active ? "bg-surface-container-high" : "hover:bg-surface-container-low"}`}>
              <button onClick={() => onSelect(h.id)} className="flex-1 min-w-0 flex items-center gap-2 px-2.5 py-2 text-left">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                    tone === "mine" ? "bg-primary-container text-on-primary-container" : tone === "muted" ? "bg-surface-container-high text-outline" : "bg-secondary-container text-on-secondary-container"
                  }`}
                >
                  <Icon name={tone === "mine" ? "chat" : tone === "muted" ? "person" : "hourglass_top"} className="text-[16px]" />
                </div>
                <span className={`flex-1 min-w-0 truncate text-body-sm ${active ? "text-on-surface" : "text-on-surface-variant"}`}>
                  {h.reason || "（学员未填写原因）"}
                </span>
              </button>
              {action && <span className="pr-2">{action(h)}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const ROLE_LABEL: Record<ConversationMessage["role"], string> = { user: "学员", assistant: "机器人", teacher: "我", system: "系统" };

// 精简版的消息气泡，专给老师工作台用。对齐方向看的是"这个屏幕的主人是谁"，不是固定角色——
// 学员端 MessageBubble 里 user 靠右，是因为那个页面的主人是学员；这里的主人是老师，
// 所以靠右的是 teacher 自己，学员和机器人都是"对方"，一律靠左，只用图标/配色区分是谁。
function TeacherViewBubble({ message }: { message: ConversationMessage }) {
  if (message.role === "teacher") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] bg-primary text-on-primary px-3.5 py-2 rounded-t-xl rounded-bl-xl whitespace-pre-wrap break-words">
          <p className="text-body-sm">{message.content}</p>
        </div>
      </div>
    );
  }
  const isStudent = message.role === "user";
  return (
    <div className="flex justify-start">
      <div className="flex gap-2.5 max-w-[75%]">
        <div
          className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
            isStudent ? "bg-secondary-container" : "bg-surface-container-highest"
          }`}
        >
          <Icon name={isStudent ? "person" : "smart_toy"} filled className={`text-[15px] ${isStudent ? "text-on-secondary-container" : "text-primary"}`} />
        </div>
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-label-sm text-on-surface-variant">{ROLE_LABEL[message.role]}</span>
          <div
            className={`px-3.5 py-2 rounded-t-xl rounded-br-xl border whitespace-pre-wrap break-words ${
              isStudent ? "bg-secondary-container/20 border-secondary-container" : "bg-surface-container-low border-surface-container"
            }`}
          >
            <p className="text-body-sm text-on-surface">{message.content}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
