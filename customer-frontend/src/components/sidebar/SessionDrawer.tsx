import { useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";

import { useSessionsContext } from "../../context/SessionsContext";
import { Icon } from "../ui/Icon";
import { SessionListItem } from "./SessionListItem";

// "新建会话"+"最近会话"从左侧固定栏挪过来的地方：平时收着，不占聊天区域的宽度，
// 只在学员实际待在对话板块时才出现（跟它挪过来之前的可见范围一致）。
// 列表状态仍然来自 SessionsContext——这个 drawer 和右侧聊天面板共用同一份，面板新建会话后
// 调 refresh()，这边立刻同步，不用等整页刷新。
//
// 面板本身一直挂载着，靠 translate-x 滑出滑入（不是开的时候才渲染）：收起时整块平移到屏幕右侧之外，
// 但把手是面板自己的子元素、跟着面板一起平移——平移量刚好等于面板宽度，把手退回到视口右边缘，
// 变成一个贴边的小三角，可以一直点得到，不需要另外维护一个"收起时浮在别处"的按钮。
export function SessionDrawer() {
  const [open, setOpen] = useState(false);
  const { conversationId: activeId } = useParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { conversations, loading, error, remove } = useSessionsContext();

  const inChat = pathname === "/" || pathname.startsWith("/sessions/");
  if (!inChat) return null;

  const handleDelete = async (id: string) => {
    await remove(id);
    // 删的正好是当前打开的会话：这里不能留着一个已经不存在的 conversationId，
    // 不然右侧面板接下来的任何请求都会对着一个 404 的会话。
    if (id === activeId) navigate("/");
  };

  return (
    <>
      {/* 背板只在展开时存在、盖住整个视口：点哪都收起。收起时完全不渲染，不然会挡住收起状态下的页面点击。 */}
      {open && <div className="fixed inset-0 z-10 bg-black/20" onClick={() => setOpen(false)} />}

      <aside
        aria-label="会话列表"
        className={`fixed right-0 top-0 z-20 h-full w-80 bg-background border-l border-outline-variant flex flex-col py-inset-padding shadow-xl transition-transform duration-200 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* 把手：贴在面板左边缘，垂直居中；面板收起时跟着一起平移到视口右边缘，露出一个贴边的小三角。 */}
        <button
          type="button"
          aria-label={open ? "收起会话列表" : "展开会话列表"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="absolute -left-6 top-1/2 -translate-y-1/2 w-6 h-16 rounded-l-lg bg-surface-container-high shadow-md flex items-center justify-center hover:opacity-90 active:scale-95 transition-all"
        >
          {/* border-left 的三角形尖端指向右，border-right 指向左：收起时指左（往屏幕里拉出来的方向），
              展开时指右（推回去收起的方向），箭头方向始终是"点一下会发生什么"，不是"面板现在在哪"。 */}
          <span
            className="w-0 h-0 border-y-[7px] border-y-transparent"
            style={open ? { borderLeft: "9px solid var(--color-on-surface)" } : { borderRight: "9px solid var(--color-on-surface)" }}
          />
        </button>

        <div className="px-4 mb-4 mt-4">
          <Link
            to="/"
            onClick={() => setOpen(false)}
            className="w-full bg-primary text-on-primary py-3 px-4 rounded-xl text-label-md flex items-center justify-center gap-2 hover:opacity-90 active:scale-[0.98] transition-all"
          >
            <Icon name="add" />
            新建会话
          </Link>
        </div>

        <div className="flex-1 overflow-y-auto px-2 custom-scrollbar">
          <div className="px-2 pb-2">
            <p className="text-[11px] font-bold text-outline uppercase tracking-wider mb-2 px-2">最近会话</p>

            {loading && <p className="px-2 text-body-sm text-outline">加载中…</p>}
            {error && (
              <p className="px-2 text-body-sm text-error">
                服务连接失败：{error}
                <br />
                请确认 education-api 已启动
              </p>
            )}
            {!loading && !error && conversations.length === 0 && <p className="px-2 text-body-sm text-outline italic">还没有会话</p>}

            {conversations.map((c) => (
              <SessionListItem key={c.id} conversation={c} active={c.id === activeId} onDelete={handleDelete} onNavigate={() => setOpen(false)} />
            ))}
          </div>
        </div>
      </aside>
    </>
  );
}
