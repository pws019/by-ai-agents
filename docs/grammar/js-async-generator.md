# JS 中 async 与生成器（`*`）语法一起用

上一篇 [js-async.md](./js-async.md) 讲的 `async/await` 只能"等一个值"——函数执行一次，返回一个结果。但如果需要**陆续吐出一串值**，比如逐条处理一个 SSE 流、分页读一个很大的数据源，就需要生成器（generator）。这篇讲生成器本身，再讲它和 `async`、`await` 结合之后的**异步生成器**。

## 前置知识：迭代器协议（iterator protocol）

`for...of`、数组解构、`[...arr]` 这些语法，背后都依赖同一套约定，叫**迭代器协议**。一个对象只要满足这套约定，就能被这些语法消费。

约定很简单：这个对象要有一个 `Symbol.iterator` 方法，调用它会返回一个"迭代器"，迭代器要有一个 `.next()` 方法，每次调用返回 `{ value, done }`：

```js
const iterator = [10, 20][Symbol.iterator]();
iterator.next(); // { value: 10, done: false }
iterator.next(); // { value: 20, done: false }
iterator.next(); // { value: undefined, done: true }
```

`for...of` 做的事，其实就是不停调用 `.next()`，直到 `done` 变成 `true`：

```js
for (const x of [10, 20]) console.log(x);
// 等价于上面手动调用 .next() 的过程，只是语法帮你自动重复
```

数组、字符串、`Map`、`Set` 都内置实现了这个协议，所以都能用 `for...of`。

## 生成器：手写一个"可暂停"的迭代器

自己实现 `Symbol.iterator` + `.next()` 很啰嗦，**生成器函数**（`function*`）帮你把这套模板代码全包了。

```js
function* countUpTo(n) {
  for (let i = 1; i <= n; i++) {
    yield i;   // 暂停在这里，把 i 交出去
  }
}

const gen = countUpTo(3);
gen.next(); // { value: 1, done: false }
gen.next(); // { value: 2, done: false }
gen.next(); // { value: 3, done: false }
gen.next(); // { value: undefined, done: true }

for (const x of countUpTo(3)) console.log(x); // 1 2 3
```

关键点：

- **函数名前面加 `*`**，标记这是一个生成器函数。
- **调用生成器函数不会立即执行函数体**，只会返回一个生成器对象（它自己就实现了迭代器协议，可以直接 `for...of`）。
- 每次调用 `.next()`，函数体从上次 `yield` 的位置**继续往下跑**，跑到下一个 `yield` 再次暂停。
- `yield` 既是"往外吐一个值"，也是一个暂停点——这和 `await` 很像："`await` 是暂停等结果进来，`yield` 是暂停把结果送出去"。

**惰性求值**是生成器相对"直接返回一个数组"的核心优势：

```js
function* naturals() {
  let i = 1;
  while (true) yield i++;   // 无限序列，写成数组会直接爆内存
}

for (const n of naturals()) {
  if (n > 5) break;
  console.log(n);           // 1 2 3 4 5
}
```

调用方要一个才算一个，不要就永远不会去计算下一个值，`break` 之后生成器直接停在原地，不会继续跑。

## 异步可迭代协议：Symbol.asyncIterator

前面的迭代器协议是**同步**的：`.next()` 立刻返回值。但如果每一项数据都要"等"（比如网络流的下一个数据块什么时候到不确定），就需要异步版本：`Symbol.asyncIterator`，它的 `.next()` 返回的是一个 **Promise**（`Promise<{value, done}>`），而不是直接返回结果。

## 异步生成器：async function*

同时需要"暂停等结果"（`await`）和"暂停吐值"（`yield`）的场景，就用 `async function*`——它是 `function*` 和 `async function` 的结合体，函数体内可以同时使用两个关键字：

```js
async function* fetchPages(url) {
  let next = url;
  while (next) {
    const res = await fetch(next);        // 等网络请求
    const page = await res.json();        // 再等一次
    yield page.items;                     // 吐出这一页的数据
    next = page.nextUrl;
  }
}
```

调用 `fetchPages(url)` 同样不会立即执行，返回的是一个**异步生成器对象**，它自动实现了 `Symbol.asyncIterator`。

## 消费端：for await...of

普通的 `for...of` 消费的是同步迭代器，`.next()` 拿到的值就是最终值。消费异步生成器，要用 `for await (const x of ...)`——每次 `.next()` 拿到的是一个 Promise，`for await` 会自动帮你 `await` 它：

```js
for await (const items of fetchPages("/api/list?page=1")) {
  console.log(items);
}
```

`for await` 也能消费"数组套 Promise"这种普通的异步可迭代对象，不一定非要是异步生成器产出的，但在这个项目里，`for await` 几乎总是和 `async function*` 成对出现。

## 生成器 vs "返回一个完整数组"

| | 返回完整数组 | 生成器 |
|---|---|---|
| 什么时候拿到数据 | 全部处理完，一次性给你 | 按需一个一个给，边处理边给 |
| 内存占用 | 要一次性放下所有数据 | 只需要放当前这一项 |
| 能不能处理无限/未知长度的序列 | 不能 | 可以（比如流式响应，不知道什么时候结束） |
| 消费方能不能提前中止 | 已经全部算完了，中止也没用 | 可以，`break` 之后剩下的不会再计算 |

**一句话总结**：`async function*` = "既能暂停等结果（`await`），又能暂停吐一个值出去（`yield`）"的函数，专门用来处理"数据分批、陆续到达"的场景。

## 和这个项目的关系

这套语法在这个项目里不是纸上谈兵——education-api 里真实用它来解析和转发 Agent 服务发回的 SSE（Server-Sent Events）事件流：一段负责把网络字节流解析成一个个结构化事件（`async function* parseSse`），另一段负责把这些事件原样转发给浏览器（`for await` 消费）。具体代码坐标见 [project-examples.md](./project-examples.md)。

## 和下一篇的关系

下一篇 [python-async.md](./python-async.md) 讲 Python 的 `async/await`。Python 的协程模型和 JS 的 Promise 模型有一处关键差异——`async def` 函数被调用时**根本不会开始执行**，这一点比 JS 的 `async function` 更"绕"，是初学者最容易踩的坑，那篇会重点讲。
