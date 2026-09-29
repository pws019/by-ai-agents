# JS 中的 async 语法

这篇讲 JavaScript / TypeScript 里 `async`/`await` 的核心机制：它到底在等什么、为什么"看起来是同步写法，跑起来是异步的"，以及围绕它最容易踩的几个坑。生成器（`function*`）和异步生成器（`async function*`）单独放在 [js-async-generator.md](./js-async-generator.md) 里讲，这篇先把 `async/await` 本身讲透。

## 前置知识：事件循环的极简模型

JS 是单线程的：同一时刻只有一段代码在跑。异步操作（网络请求、定时器、文件 I/O）不会阻塞这个线程，而是"registered"（登记）之后先放一边，线程继续往下跑，等结果回来了再"回头"处理。这个"回头处理"的调度机制就是**事件循环（event loop）**。

只需要记住三层排队，够用来理解本文档后面的所有例子：

1. **调用栈（call stack）**：当前正在执行的函数链。同步代码全部在这里跑完，一步不落。
2. **微任务队列（microtask queue）**：`Promise` 的 `.then`/`.catch`、`await` 之后的代码，都会进这里。**调用栈一空，会先把微任务队列清空**，再去看宏任务。
3. **宏任务队列（task queue / macrotask）**：`setTimeout`、`setInterval`、I/O 回调、UI 事件。每次只从这里取一个任务执行，执行完再检查微任务队列。

一句话记住优先级：**同步代码 > 全部微任务 > 一个宏任务 > 全部微任务 > 一个宏任务 …** 循环下去。

```js
console.log("1");
setTimeout(() => console.log("2"), 0);   // 宏任务，即使延时是 0 也要排队
Promise.resolve().then(() => console.log("3")); // 微任务
console.log("4");
// 输出顺序：1 4 3 2
```

`await` 之后的代码，本质上就是被包进了一个微任务，所以它比 `setTimeout(0)` 更早执行。

## Promise：async/await 的地基

`Promise` 是"一个未来会有结果的值"的容器，有且只有三种状态：

| 状态 | 含义 | 能否再变 |
|---|---|---|
| `pending` | 还没有结果 | 会变成下面两种之一 |
| `fulfilled` | 成功，带一个值 | 不会再变 |
| `rejected` | 失败，带一个原因 | 不会再变 |

一旦从 `pending` 变成 `fulfilled` 或 `rejected`，这个 Promise 就**永久定型**，不会再变。

```js
const p = fetch("/api/v1/me");
p.then((res) => console.log("成功", res))
 .catch((err) => console.log("失败", err))
 .finally(() => console.log("不管成败都会跑"));
```

## async/await 是 Promise 的语法糖

`async function` 有两个固定行为：

1. **返回值自动被包成 Promise**。就算你 `return 1`，调用方拿到的也是 `Promise<1>`。
2. **函数体里可以用 `await`**，暂停当前函数的执行，直到某个 Promise 落定（fulfilled 或 rejected），再拿着结果往下走。

```js
async function getMe() {
  const res = await fetch("/api/v1/me");   // 暂停在这里，直到 fetch 的 Promise 落定
  const data = await res.json();           // 再暂停一次
  return data;                              // 返回值自动包成 Promise<data>
}

// 等价的、没有 async/await 的写法：
function getMe() {
  return fetch("/api/v1/me").then((res) => res.json());
}
```

`await` 只是让"等 Promise 落定"这件事，**写起来像同步代码**，本质上没有绕开事件循环——`await` 那一行之后的代码，依然是排在微任务队列里执行的。

## 错误处理：try/catch 包住 await

`await` 一个被 reject 的 Promise，会**像同步代码抛异常一样**被 `throw` 出来，可以直接用 `try/catch` 接住：

```js
async function login(body) {
  try {
    const res = await fetch("/auth/login", { method: "POST", body });
    if (!res.ok) throw new Error("登录失败");
    return await res.json();
  } catch (err) {
    console.error("处理登录出错：", err);
    return null;
  }
}
```

不用 `try/catch` 也可以，退回用 `.catch`：

```js
async function login(body) {
  return fetch("/auth/login", { method: "POST", body })
    .then((res) => res.json())
    .catch((err) => { console.error(err); return null; });
}
```

两种写法效果一样，`try/catch` 是 `async/await` 风格更自然的搭配。

## 串行 vs 并发

**串行**：一个 `await` 接一个，后一个必须等前一个彻底完成才开始。

```js
const a = await stepA();   // 假设耗时 200ms
const b = await stepB();   // 再耗时 300ms
// 总耗时约 500ms
```

如果 `stepB` 不依赖 `stepA` 的结果，这样写就是白白浪费时间。

**并发**：用 `Promise.all` 同时发起多个异步操作，等**全部**完成后统一拿结果。

```js
const [a, b] = await Promise.all([stepA(), stepB()]);
// 两个几乎同时开始，总耗时约等于耗时最长的那个（约 300ms）
```

几个常用的"多 Promise 收口"方法：

| 方法 | 行为 |
|---|---|
| `Promise.all` | 全部成功才成功；**任意一个失败，整体立刻失败**，不等其他的 |
| `Promise.allSettled` | 不管成败，等全部落定，返回每一个的结果（`{status, value}` 或 `{status, reason}`） |
| `Promise.race` | 谁先落定（不管成功失败）就用谁的结果，其余的忽略 |

**判断准则**：多个异步操作之间**有没有先后依赖**。有依赖，必须串行；没有依赖，用 `Promise.all` 并发。

## 常见的坑

**1. 忘了 `await`**

```js
async function save() {
  db.insert(row);        // 忘了 await：函数在插入完成之前就返回了
  return "ok";
}
```

`db.insert` 返回的 Promise 没人等，插入操作在"后台"跑，函数已经返回。调用方以为存完了，其实存储可能还没完成，出错也没人捕获到。

**2. `.forEach` 里用 `async` 回调不会被等待**

```js
// 错误：以为这样能等所有循环跑完
items.forEach(async (item) => {
  await save(item);
});
console.log("全部保存完成"); // 实际上这行几乎立刻执行，跟循环里的 save 完全不同步
```

`forEach` 不认识返回的 Promise，也不会等它。想要"等所有项都处理完"，改用 `for...of` 加 `await`（串行），或者 `Promise.all` 加 `.map`（并发）：

```js
for (const item of items) await save(item);          // 串行
await Promise.all(items.map((item) => save(item)));  // 并发
```

**3. 没处理的 rejection（unhandled rejection）**

一个 Promise 被 reject，但没有任何 `.catch`（或包它的 `try/catch`）去接，Node 会打印一条 `UnhandledPromiseRejection` 警告，严重时甚至会让进程崩溃。任何"发出去就不管"的异步调用，至少要挂一个 `.catch` 兜底。

## 故意的 fire-and-forget

不是所有异步调用都要 `await`。有时候你**故意**不想等一个异步操作完成就往下走——比如触发一个后台任务，让它自己跑，不阻塞当前请求的响应。这种写法叫 **fire-and-forget**（发射后不管）。

要做到"安全的 fire-and-forget"，有两个条件缺一不可：

1. **明确表达"这是故意的，不是忘了 await"**。常见写法是在调用前加 `void`，它是一个操作符，告诉阅读代码的人（和 linter）："这个 Promise 的结果我不需要"。
2. **一定要挂 `.catch`**，哪怕什么都不做，否则会撞上前面说的 unhandled rejection。

```js
void backgroundTask().catch(() => {}); // 故意不等，但吞掉可能的异常，避免进程报错
```

`docs/grammar/project-examples.md` 里会展示这个项目中一处真实的 fire-and-forget，以及为什么那里要这样设计。

## 顶层 await

在 ES Module（`.mjs` 或 `package.json` 里 `"type": "module"`）里，可以在模块最外层直接写 `await`，不需要包一层 `async function`：

```js
// top-level await，只能在模块顶层，不能在 CommonJS 的 require 模块里用
const config = await loadConfig();
```

日常业务代码里用得不多，多见于启动脚本、一次性任务脚本。

## 和下一篇的关系

`async/await` 解决的是"等一个值"的问题——一次只能等到一个结果。如果需要"陆续吐出很多个值"（比如一条一条处理流式数据），就需要生成器和异步生成器，这是 [js-async-generator.md](./js-async-generator.md) 要讲的内容。
