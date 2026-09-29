# 项目中的语法应用示例

前 4 篇（[js-async.md](./js-async.md)、[js-async-generator.md](./js-async-generator.md)、[python-async.md](./python-async.md)、[python-async-generator.md](./python-async-generator.md)）讲的是语法本身，这一篇把每种语法钉在这个项目的真实代码上：文件路径、代码原文、以及这段代码在业务上做什么。所有代码片段均按调研时的实际内容摘录，未做改写；行号可能随代码变动而漂移，以文件内容为准。

涉及两个子项目：`education-api`（TypeScript / Hono，是浏览器和 Agent 服务之间的 BFF）、`education-agent`（Python / LangGraph + FastAPI，是真正驱动 AI 对话的服务）。

## 一、TS 侧：普通 async 函数

**Hono 路由处理函数**

[`education-api/src/routes/applications.ts:225`](../../education-api/src/routes/applications.ts)：

```ts
app.post("/applications/drafts", async (c) => {
  const actor = c.get("actor")!;
  const body = await c.req.json().catch(() => null);
  ...
```

普通的 `async` 回调，对应 [js-async.md](./js-async.md) 里"`async function` 返回值自动包成 Promise"这条——Hono 框架内部会 `await` 这个回调的返回值。

**async 中间件**

[`education-api/src/auth/middleware.ts:79`](../../education-api/src/auth/middleware.ts)：

```ts
/** 挂在需要登录的路由前：没有身份直接 401，不进 handler。 */
export async function requireAuth(c: Context, next: Next) {
  if (!c.get("actor")) return errorJson(c, 401, "UNAUTHORIZED", "需要登录");
  await next();
}
```

中间件本身也是 `async` 函数，`await next()` 把控制权交给下一个中间件/路由处理函数，等它跑完（包括它内部所有的异步操作）才算这一层中间件完成。

## 二、TS 侧：串行 await 链

[`education-api/src/routes/applications.ts:235-253`](../../education-api/src/routes/applications.ts)：

```ts
const [enrollment] = await db
  .select({ id: enrollments.id })
  .from(enrollments)
  .where(and(eq(enrollments.id, body.enrollmentId), eq(enrollments.studentId, actor.id), eq(enrollments.status, "active")));
if (!enrollment) return errorJson(c, 404, "NOT_FOUND", "报名不存在，或不属于当前学员，或已结束");

if (body.targetCohortId) {
  const [cohort] = await db.select({ id: cohorts.id }).from(cohorts).where(eq(cohorts.id, body.targetCohortId));
  if (!cohort) return errorJson(c, 404, "NOT_FOUND", "目标班期不存在");
}

const sourceRunId = c.get("via") === "agent" ? await findRunOwnedBy(db, c.get("agentRunId"), actor.id) : null;

try {
  const { row, confirmation } = await db.transaction(async (tx) => {
    const [row] = await tx.insert(applications).values({ ... }) ...
```

三次数据库查询依次执行：先确认报名存在，再（如果有目标班期）确认目标班期存在，再判断来源，最后才进事务插入。这是[js-async.md](./js-async.md)"串行 vs 并发"一节说的**有依赖必须串行**的场景——后一步要用到前一步的判断结果（比如报名不存在就直接 404，根本不用查后面）。

## 三、TS 侧：真正的 async function* + for await

**生产端：解析 SSE 字节流**

[`education-api/src/chat/agentClient.ts:49-62`](../../education-api/src/chat/agentClient.ts)：

```ts
/** 解析 SSE：事件之间以空行分隔；一个事件里取 data 行的 JSON。字节块的边界可以落在任何位置（含一个汉字的中间）。 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<AgentEvent> {
  const decoder = new TextDecoder(); // stream: true 会把被切断的多字节字符留到下一块
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (data) yield JSON.parse(data) as AgentEvent;
    }
  }
}
```

这就是 [js-async-generator.md](./js-async-generator.md) 讲的 `async function*` 的标准形态：函数体里既有 `for await`（消费网络字节流，等下一块数据到达）又有 `yield`（每解析出一个完整事件就吐一个出去）。它把"HTTP 响应体是一串不知道什么时候完、且可能在任意字节位置被切断的字节流"，转换成"一个一个结构化的 `AgentEvent` 对象"，调用方完全不用关心 SSE 协议本身的解析细节。

**类的异步生成器方法：可重放的事件通道**

[`education-api/src/chat/supervisor.ts:48-63`](../../education-api/src/chat/supervisor.ts)：

```ts
export class RunChannel {
  private readonly events: AgentEvent[] = [];
  private finished = false;
  private readonly wakeups = new Set<() => void>();

  push(event: AgentEvent) {
    this.events.push(event);
    this.wake();
  }

  finish() {
    this.finished = true;
    this.wake();
  }

  /** 从头回放已有事件，再接着收新事件，直到运行结束或订阅者的 signal 被取消（浏览器断开）。 */
  async *subscribe(signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    let i = 0;
    while (true) {
      while (i < this.events.length) yield this.events[i++]!;
      if (this.finished || signal?.aborted) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          this.wakeups.delete(done);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        this.wakeups.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
  }

  private wake() {
    for (const w of [...this.wakeups]) w();
  }
}
```

`subscribe` 是类方法版本的异步生成器（`async *方法名`，和独立函数的 `async function*` 是同一回事）。它体现了生成器"惰性、按需产出"的另一种用法：先把已经攒下的事件全部 `yield` 出去（回放），再 `await` 一个 Promise 把自己挂起，直到有新事件推进来（`push` 调用 `wake()`）或者订阅者主动断开（`signal.aborted`）才继续。**这不是在处理"一批已知长度的数据"，而是在建模一个"随时可能有新数据、随时可能被取消"的长连接**，用普通的返回值/回调很难写得这么清晰。

**消费端**

[`education-api/src/chat/supervisor.ts:116`](../../education-api/src/chat/supervisor.ts)：

```ts
try {
  for await (const event of events) {
    ...
    if (!FORWARDED_TYPES.has(event.type)) continue;
    if (event.type === "message.completed") { ... }
    if (event.type === "run.error") { ... }
    forward(event);
  }
```

[`education-api/src/chat/routes.ts:146`](../../education-api/src/chat/routes.ts)：

```ts
for await (const e of channel.subscribe(gone.signal)) {
  await stream.writeSSE({ id: e.eventId, event: e.type, data: JSON.stringify(e) });
}
```

两处都是标准的 `for await...of` 消费异步生成器：一处是后台任务消费 Agent 发来的原始事件流，逐条判断类型、落库、转发；一处是把 `RunChannel` 的输出直接写成浏览器能收到的 SSE 响应。

## 四、TS 侧：故意的 fire-and-forget

[`education-api/src/chat/supervisor.ts:92`](../../education-api/src/chat/supervisor.ts)：

```ts
const channel = new RunChannel();
void consume(deps, args, started.events, channel, abort).catch(() => {}); // consume 自己处理了所有错误，这里只防止未捕获的 rejection
return { kind: "streaming", channel };
```

这正是 [js-async.md](./js-async.md) "故意的 fire-and-forget" 一节说的两个条件：`void` 明确表示"这个 Promise 的结果不需要等"，`.catch(() => {})` 兜底防止 unhandled rejection。

**为什么这里必须不 await**：`supervisor.ts` 开头的注释说得很直接——"运行的生命周期不绑在浏览器连接上"。如果 `beginRun` 里 `await consume(...)`，那这个函数要等 Agent 把整段对话跑完才能返回，而 `consume` 内部要一直循环到 `message.completed` 或 `run.error` 才会结束（见下面 `consume` 函数体），这可能长达几十秒。`beginRun` 的调用方（HTTP 路由）需要立刻拿到一个 `channel` 去开 SSE 响应，而不是等整个对话跑完才有响应——**这是一个业务上的设计决定，不是漏写了 await**。

## 五、TS 侧：pg.Client 的事务性异步操作

[`education-api/src/db/migrate.ts:22-67`](../../education-api/src/db/migrate.ts)：

```ts
export async function migrate(connectionString: string, dir: string): Promise<string[]> {
  const client = new pg.Client({ connectionString, options: `-c search_path=${APP_SCHEMA}` });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    ...
    for (const name of files) {
      ...
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [name, checksum]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`迁移 ${name} 失败: ${(err as Error).message}`, { cause: err });
      }
      ran.push(name);
    }
    return ran;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    await client.end();
  }
}
```

每一步数据库操作都是 `await client.query(...)`，串行执行（每条迁移文件必须按顺序应用，且一个成功了下一个才能继续），`try/finally` 保证不管中间是否抛异常，最后都会释放锁、关闭连接。

## 六、TS 侧对比样例：真实的 Promise.all

education-api 里没有出现 `Promise.all`（内部全是有依赖的串行 await）。真正的并发写法可以参考同一仓库下的 `customer-agents`：

[`customer-agents/src/scripts/ingest-rag-knowledge.ts:26`](../../customer-agents/src/scripts/ingest-rag-knowledge.ts)：

```ts
// 2. 把 Markdown 按"## 场景"切成 chunk。
//    例如三份文档各 6 个场景，就会得到 18 个 chunk。
const chunks = (await Promise.all(files.map(loadMarkdownChunks))).flat();
```

`files.map(loadMarkdownChunks)` 先产出一堆 Promise（每个文件各自异步解析，互不依赖），`Promise.all` 一次性并发发起、统一等待，这正是 [js-async.md](./js-async.md) 里"没有依赖就该用 `Promise.all`"的例子。

## 七、Python 侧：LangGraph 节点全是 async def

[`education-agent/src/education_agent/graphs/student_graph.py`](../../education-agent/src/education_agent/graphs/student_graph.py) 里，图的每一个节点函数都是 `async def`：

```python
async def load_authorized_context(state: GraphState, runtime: Runtime[RunScope]) -> GraphState:
    fresh: GraphState = {"branch": "", "stop_reason": "", "reply": "", "confirmation": None}
    if runtime.context.ctx.is_expired():
        return {**fresh, "stop_reason": "auth_expired"}
    return fresh

async def route(state: GraphState) -> GraphState:
    reply = await model.chat([_system(ROUTE_PROMPT), *_text_turns(state["messages"])], [])
    label = reply.text.strip().lower()
    return {"branch": label if label in BRANCHES else DEFAULT_BRANCH}

async def await_confirmation(state: GraphState) -> GraphState:
    # 恢复时本节点从头重跑：interrupt 之前只读状态，不做任何有副作用的事。
    interrupt({
        "type": "need_confirmation",
        "reply": state["reply"],
        "confirmation": state["confirmation"],
    })
    return {}

async def verify_outcome(state: GraphState, runtime: Runtime[RunScope]) -> GraphState:
    card = state["confirmation"]
    res = await application_tools.call(
        "getApplicationStatus", {"applicationId": card["applicationId"]}, runtime.context.ctx, runtime.context.budget
    )
    ...
```

LangGraph 编译图时（`g.add_node("route", route)`）注册的直接就是这些协程函数，图在运行到某个节点时，才会真正 `await` 它——这是 [python-async.md](./python-async.md) 强调的"`async def` 调用不立即执行"的一个具体体现：图的节点在没轮到它之前，根本不会被调用。

## 八、Python 侧：FastAPI 路由 + 判断可恢复的中断

[`education-agent/src/education_agent/server.py:59-77`](../../education-agent/src/education_agent/server.py)：

```python
@app.post("/internal/runs")
async def run(body: RunRequest, x_actor_context: str | None = Header(default=None)):
    ctx = verify_context(x_actor_context or "", secret)
    if ctx is None:
        return _error(401, "UNAUTHENTICATED")

    thread_id = f"{ctx.actor_id}:{body.conversationId}"
    config = {"configurable": {"thread_id": thread_id}}

    if body.resume and not (await graph.aget_state(config)).next:
        # 这个会话没有挂起的确认可恢复。放在开流之前判断，让调用方拿到普通的 409 而不是一个空的事件流。
        return _error(409, "NOT_AWAITING_CONFIRMATION")

    graph_input: Any = Command(resume=True) if body.resume else {"messages": [{"role": "user", "content": body.text}]}
    events = _stream_run(graph, graph_input, config, RunScope(ctx, RunBudget()), str(body.conversationId), ctx.request_id)
    return StreamingResponse(
        events, media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
```

`await graph.aget_state(config)` 是一次异步查询（读 Postgres 里的 checkpoint），先确认"确实有挂起的确认卡"再决定要不要开流；`_stream_run(...)` 这一行**没有 `await`**——因为它是个异步生成器（见下一节），调用它同样不会立即执行，只是拿到一个生成器对象，交给 `StreamingResponse` 之后，才会在真正响应时一步步驱动它跑起来。

## 九、Python 侧重点例子：async def + yield 生产 SSE 帧

[`education-agent/src/education_agent/server.py:82-104`](../../education-agent/src/education_agent/server.py)：

```python
async def _stream_run(graph, graph_input, config, scope: RunScope, conversation_id: str, run_id: str) -> AsyncIterator[str]:
    seq = 0

    def frame(type_: str, payload: dict) -> str:
        nonlocal seq
        seq += 1
        envelope = {"eventId": str(seq), "conversationId": conversation_id, "runId": run_id, "type": type_, "payload": payload}
        return f"id: {seq}\nevent: {type_}\ndata: {json.dumps(envelope, ensure_ascii=False)}\n\n"

    try:
        async for event in graph.astream(graph_input, config, context=scope, stream_mode="custom"):
            yield frame(event["type"], {k: v for k, v in event.items() if k != "type"})

        state = await graph.aget_state(config)
        for task in state.tasks:
            for interrupt in task.interrupts:
                if interrupt.value.get("type") == "need_confirmation":
                    yield frame("application.confirmation", interrupt.value["confirmation"])
        yield frame("message.completed", {"text": state.values["reply"]})
    except Exception:
        log.exception("run failed runId=%s", run_id)
        yield frame("run.error", {"code": "INTERNAL", "message": RUN_ERROR_MESSAGE})
```

这是这个项目里最典型的异步生成器：`async def ... -> AsyncIterator[str]`，函数体里 `async for` 消费 LangGraph 的 `astream`（等图产出下一个自定义事件），`yield` 把每个事件编码成一帧 SSE 文本产出。它是[js-async-generator.md](./js-async-generator.md) 里 `parseSse` 的**镜像**——`parseSse` 是**消费方**（把字节流解析成事件对象），`_stream_run` 是**生产方**（把事件对象编码成字节流），一个在 TS 这一端，一个在 Python 那一端，通过 HTTP 的 SSE 协议衔接。

这里还有一个 [python-async.md](./python-async.md) 讲过的 `nonlocal` 的真实场景：`frame` 是定义在 `_stream_run` 内部的闭包函数，它要给每一帧 SSE 消息生成一个递增的 `eventId`（`seq`）。`seq` 定义在外层的 `_stream_run` 里，`frame` 每次被调用都要**修改**它并让修改在下次调用时依然可见——不加 `nonlocal seq`，`seq += 1` 会被 Python 当成 `frame` 自己的新局部变量，第一次调用就会因为"读取了尚未赋值的局部变量"直接报错。

## 十、Python 侧：@asynccontextmanager 用例

**管理数据库连接池**

[`education-agent/src/education_agent/checkpoint.py:10-26`](../../education-agent/src/education_agent/checkpoint.py)：

```python
@asynccontextmanager
async def open_checkpointer(dsn: str = DATABASE_URL):
    """打开 Postgres checkpointer。..."""
    async with AsyncConnectionPool(
        dsn,
        kwargs={
            "autocommit": True,
            "prepare_threshold": 0,
            "row_factory": dict_row,
            "options": f"-c search_path={CHECKPOINT_SCHEMA}",
        },
        open=False,
    ) as pool:
        saver = AsyncPostgresSaver(pool)
        await saver.setup()  # 幂等：已建表则跳过
        yield saver
```

`yield saver` 之前是"进入"逻辑（建连接池、建表），`yield` 把 `saver` 交给调用方使用，调用方用完、退出 `async with` 语句块时，外层 `async with AsyncConnectionPool(...) as pool` 会自动关闭连接池——这里连"退出逻辑"都不用单独写 `finally`，因为清理工作被委托给了内层的 `async with`。

**用作 FastAPI 的 lifespan（此前详细讲过的那个文件）**

[`education-agent/src/education_agent/app.py:14-44`](../../education-agent/src/education_agent/app.py)：

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    async with AsyncConnectionPool(DATABASE_URL, kwargs={...}, open=False) as pool:
        checkpointer = AsyncPostgresSaver(pool)
        await checkpointer.setup()
        async with pool.connection() as conn:
            await conn.execute("CREATE TABLE IF NOT EXISTS spike_log (...)")

        async def log(thread_id: str, node: str) -> None:
            async with pool.connection() as conn:
                await conn.execute("INSERT INTO spike_log (thread_id, node) VALUES (%s, %s)", (thread_id, node))

        app.state.pool = pool
        app.state.graph = build_graph(checkpointer, log)
        yield
```

`yield` 前面是应用启动时要做的事（建池、建表、装配图），`yield` 之后（这里省略了，因为在 `async with` 块内，退出块时自动清理）是应用关闭时的清理。FastAPI 把这整个函数交给 `lifespan=` 参数，`yield` 之前和之后分别对应"启动完成"和"即将关闭"两个时机。

同一个文件里，`ainvoke`（对应 [python-async.md](./python-async.md) 讲过的 `await` 一个协程）被用来非流式地跑一次图：

```python
@app.post("/spike/{task_id}/start")
async def start(task_id: str, body: StartBody | None = None):
    ...
    await app.state.graph.ainvoke(dict1, _cfg(task_id))
    return await _snapshot(task_id)
```

## 十一、Python 侧：asyncio.wait_for 超时控制

[`education-agent/src/education_agent/tools/runtime.py:89`](../../education-agent/src/education_agent/tools/runtime.py)：

```python
# 两层超时各管一段：BusinessApi 里传给 httpx 的 timeout 管"单个 HTTP 请求"（连接/读取）；
# 这里的 wait_for 管"整个 handler"，因为一个工具可能连着发好几个请求，
# 每个都没超时，加起来也可能太久。超时时 wait_for 会取消 handler 里还在跑的请求。
output = await asyncio.wait_for(spec.handler(api, args), timeout=spec.timeout_s)
```

这正是 [python-async.md](./python-async.md) 讲的"给一整段可能包含多次网络调用的逻辑设一个总超时"的真实例子，和单次 HTTP 请求自己的超时是两层不同粒度的保护。

## 十二、Python 侧：串行 await 的 ReAct 循环

[`education-agent/src/education_agent/graphs/loop.py:56-77`](../../education-agent/src/education_agent/graphs/loop.py)：

```python
while True:
    reply = await model.chat(history, tools.schemas(), on_text=lambda t: emit({"type": "message.delta", "text": t}))
    ...
    if not reply.tool_calls:
        return LoopResult(new, "answered", text=reply.text)

    for call in reply.tool_calls:
        if confirmation is not None:
            add(_tool_message(call.id, {"ok": False, "error": {"code": "SKIPPED"}}))
            continue
        emit({"type": "tool.status", "tool": call.name, "status": "started"})
        result = await tools.call(call.name, call.args, ctx, budget)
        emit({"type": "tool.status", "tool": call.name, "status": "succeeded" if result.ok else "failed"})
        ...
```

模型每次产出的多个工具调用，是**逐个 `await` 执行**，不是并发跑（没有用 `asyncio.gather`）。这是有意的串行：一旦某次调用产出了确认卡（`confirmation is not None`），后续调用要被跳过（`continue`），不能已经并发发出去了才后悔——**并发在这里反而是错误的**，因为工具调用之间存在"一旦出现确认卡，后面就不该再执行"的业务依赖，这呼应了 [js-async.md](./js-async.md) 和 [python-async.md](./python-async.md) 反复强调的判断准则：**有依赖必须串行**。

## 十三、Python 侧：LangGraph 的 `a` 前缀异步方法一览

| 方法 | 调用位置 | 用途 |
|---|---|---|
| `graph.astream(...)` | `server.py:92` | 消费图的自定义流事件（`stream_mode="custom"`），驱动 SSE |
| `graph.aget_state(config)` | `server.py:68`、`server.py:95`、`app.py:63` | 判断是否有挂起的中断（`.next`）、读取最终状态 |
| `graph.ainvoke(...)` | `app.py:79`、`app.py:98` | spike 版本里非流式地跑一次图 |
| `llm.ainvoke(...)` | `model/langchain_adapter.py:46` | 非流式场景下直接调用底层 LangChain 模型 |
| `llm.astream(...)` | `model/langchain_adapter.py:85` | 流式场景下逐块拿模型输出并合并（`async for chunk in llm.astream(messages)`） |

正式版（`student_graph.py`/`server.py`）只用 `astream` + `aget_state`；`ainvoke` 只出现在 `app.py` 的 T-04 spike 版本里——同一套图，两种驱动方式的对照：一个流式、一个一次性拿到最终结果。

## 十四、对比样例：同步生成器也能驱动 SSE

生成器不一定要是 `async` 的。同一仓库下的 `customer-http-demo`（Python + FastAPI + transformers）用的是**普通同步生成器**：

[`customer-http-demo/model.py:91-116`](../../customer-http-demo/model.py)：

```python
def generate_stream(
    messages: list[dict], max_new_tokens: int, temperature: float, top_p: float, tools: list[dict] | None = None,
) -> Iterator[str]:
    """流式生成，逐个文本片段 yield 出来，供 SSE 使用。"""
    ...
    thread = threading.Thread(target=_run)
    thread.start()

    for chunk in streamer:
        if chunk:
            yield chunk

    thread.join()
```

[`customer-http-demo/main.py:119-176`](../../customer-http-demo/main.py)：

```python
def event_stream():
    yield sse(chunk({"role": "assistant"}))
    ...
    for piece in generate_stream(messages=messages, ...):
        ...
        yield sse(chunk({"content": piece}))
    ...
    yield "data: [DONE]\n\n"

return StreamingResponse(event_stream(), media_type="text/event-stream")
```

`generate_stream` 和 `event_stream` 都是**普通 `def` + `yield`**，不是 `async def`。模型推理本身是同步阻塞的重计算，这里的处理方式是把它丢进一个独立的 `threading.Thread` 里跑，生成器只负责从一个线程安全的队列（`TextIteratorStreamer`）里把已经算出来的文本片段 `yield` 出来。`StreamingResponse` 对同步生成器和异步生成器都能驱动。

**这说明**：SSE 流式返回，选同步生成器还是异步生成器，取决于产出下一个值这件事本身是不是"要等 I/O"——`education-agent` 的 `_stream_run` 每一步都在等 LangGraph 的下一个事件（属于 I/O 等待，适合 `async`），而这里的推理计算是 CPU 密集型的，用另开线程 + 同步生成器组合来避免阻塞事件循环反而更合适。

## 十五、首尾呼应：一对镜像函数

| | TS：`parseSse` | Python：`_stream_run` |
|---|---|---|
| 文件 | `education-api/src/chat/agentClient.ts:49` | `education-agent/src/education_agent/server.py:82` |
| 角色 | 消费者：把字节流解析成结构化事件 | 生产者：把结构化事件编码成字节流 |
| 语法 | `async function*` + `for await` | `async def` + `yield`，内部 `async for` |
| 对应文档 | [js-async-generator.md](./js-async-generator.md) | [python-async-generator.md](./python-async-generator.md) |

一个在 SSE 协议的发送端，一个在接收端，分别用 TS 和 Python 各自的异步生成器语法实现，串起了从 LangGraph 图内部的事件，到浏览器最终看到的对话文字，这条完整的数据流转链路。
