# Python 中的 async 语法

这篇讲 Python 的 `async`/`await`，重点放在它和 JS 那套（[js-async.md](./js-async.md)）看起来很像、但有几处关键差异的地方——这几处差异恰恰是最容易踩坑的地方。生成器/异步生成器（Python 没有 `*` 符号）单独放在 [python-async-generator.md](./python-async-generator.md)。

## 前置知识：协程是什么

**协程（coroutine）**：可以在中途暂停、之后再从暂停的地方继续执行的函数。`async def` 定义的就是一个协程函数。

和 JS 最大的一处不同，**必须先记住**：

```python
async def get_me():
    print("开始跑了")
    return {"id": 1}

result = get_me()
print(type(result))   # <class 'coroutine'>，不是 dict！"开始跑了" 也还没被打印
```

**调用 `async def` 函数，不会执行函数体，只会返回一个协程对象。** 这个协程对象什么都还没做，直到你：

- 用 `await` 它，或者
- 把它交给事件循环去跑（比如 `asyncio.run(get_me())`）

函数体才真正开始执行。

```python
result = await get_me()   # 现在才真的打印 "开始跑了"，result 才是 {"id": 1}
```

对比 JS：`async function` 调用时**函数体会立即同步执行到第一个 `await`**，只有返回值被包成了 Promise。Python 更彻底——**连"开始跑"这件事本身都要等你显式触发**。

**这个差异导致的一个常见 bug**：Python 里忘了 `await` 一个协程，**不会报错，只会得到一个"没人处理的协程对象"警告**（`RuntimeWarning: coroutine was never awaited`），代码里该干的事根本没干：

```python
async def save(row):
    ...

async def handler():
    save(row)   # 忘了 await：这行代码等于什么都没做，save 函数体一行都没执行
```

这一点比 JS 更隐蔽——JS 忘了 `await`，Promise 至少已经在"后台"跑起来了；Python 忘了 `await`，函数**压根没启动**。

## 事件循环从哪来

协程要跑起来，必须有一个事件循环在"驱动"它。两种常见方式：

```python
import asyncio

async def main():
    await get_me()

asyncio.run(main())   # 脚本场景：自己起一个事件循环，跑完就关闭
```

在这个项目里，事件循环是由 **uvicorn**（ASGI 服务器）启动的：FastAPI 应用运行期间，事件循环一直存在，每个请求进来的协程都在这同一个循环上调度，不需要你手写 `asyncio.run`。

## await 的语义

```python
async def load_authorized_context(state, runtime):
    ...

async def route(state):
    reply = await model.chat([...], [])   # 暂停在这里，直到 model.chat 这个协程跑完
    ...
```

`await` 暂停当前协程，把控制权交还给事件循环；事件循环趁这个空档去处理别的协程（比如另一个请求），等 `model.chat` 的结果就绪，再回来接着跑 `route` 剩下的部分。

**和 JS 的类比表**：

| Python | JS | 含义 |
|---|---|---|
| 协程（coroutine） | Promise / async function 的执行 | 一个"未来会有结果、可暂停"的计算 |
| `await` | `await` | 暂停当前函数，等结果 |
| `asyncio.Task` | Promise 被"发起"后的那个状态 | 正在被事件循环调度执行的协程 |
| `asyncio.gather(a, b)` | `Promise.all([a, b])` | 并发跑多个，等全部完成 |
| `async def` 调用只返回协程对象，不执行 | `async function` 调用会立即同步跑到第一个 await | **关键差异**，见上一节 |

## 并发：gather / create_task / wait_for

**串行**（一个接一个）：

```python
a = await step_a()
b = await step_b()
```

**并发**（同时发起，一起等）：

```python
a, b = await asyncio.gather(step_a(), step_b())
```

`asyncio.gather` 对应 JS 的 `Promise.all`：等全部协程都跑完，按顺序拿到结果。

`asyncio.create_task` 用来"发起一个协程，但暂时不等它"，之后再决定什么时候 `await` 它，或者干脆不等（这个项目目前的 Python 代码里没有出现这个用法，多见于需要更精细控制并发时机的场景）。

**给单个协程加超时**：`asyncio.wait_for`：

```python
output = await asyncio.wait_for(handler(api, args), timeout=5)
```

超过 `timeout` 秒还没结果，会抛出 `asyncio.TimeoutError`，并且会尝试取消掉还在跑的那个协程。这和"给单次 HTTP 请求设置超时"是两回事——`wait_for` 管的是"这一整段可能包含好几次网络调用的逻辑，总共不能超过多久"。

## 前置知识：闭包与 nonlocal

理解 Python 的一个"反直觉"规则，是看懂后面很多异步代码的必要前提。

Python 有一条规则：**只要函数体内对某个变量做了赋值，Python 就把它当成这个函数的局部变量**——不管这行赋值写在函数的第几行，这个判定是针对整个函数体一次性做出的。

```python
def outer():
    count = 0

    def inner():
        count += 1   # 报错：UnboundLocalError
        return count

    return inner()
```

`count += 1` 等价于 `count = count + 1`，这里有赋值动作，Python 就认为 `inner` 内部有一个自己的局部变量 `count`。但局部变量在被**读取**（`count + 1` 右边那个 `count`）的时候还没被赋过值，直接报错。

**`nonlocal` 关键字**明确告诉 Python："这个变量不是我的新局部变量，是外层函数的那个"：

```python
def outer():
    count = 0

    def inner():
        nonlocal count
        count += 1
        return count

    return inner()
```

**和 JS 对比**：JS 的闭包天然可以修改外层作用域的变量，不需要任何声明——这也是 Python 初学者最容易困惑的地方之一：

```js
function outer() {
  let count = 0;
  function inner() {
    count += 1;    // JS 里天然可以，不需要额外声明
    return count;
  }
  return inner();
}
```

这条规则不只对同步函数成立，`async def` 里定义的闭包函数一样受它约束——后面 [project-examples.md](./project-examples.md) 里会看到一个真实的 `nonlocal` 用例，出现在一个异步生成器内部定义的普通函数里。

## 最容易踩的坑：阻塞代码会卡住整个事件循环

```python
import time

async def handler():
    time.sleep(5)   # 危险！这是同步阻塞调用，不是 await asyncio.sleep(5)
    return "done"
```

`time.sleep` 是同步阻塞函数，它会**霸占住整个线程**，事件循环上所有其他协程（包括别的请求、健康检查）在这 5 秒里全部被卡住，谁都跑不了。

正确写法是用异步版本：

```python
async def handler():
    await asyncio.sleep(5)   # 只暂停当前协程，事件循环这段时间可以去处理别的
    return "done"
```

**FastAPI 的一个细节**：路由函数写成普通 `def`（不是 `async def`），FastAPI 会自动把它丢进一个独立的线程池执行，不会占用事件循环；写成 `async def`，FastAPI 就认为你会自己负责不阻塞，如果在里面写了同步阻塞代码，没人替你兜底。**这也是为什么"能不能在 `async def` 里放阻塞调用"是个必须搞清楚的规则，而不是随便选哪种写法都行。**

## async with / async for 先混个脸熟

这两个是 `with` 和 `for` 的异步版本，具体机制放到下一篇讲，这里先知道它们的用途：

- `async with`：用在需要"打开资源、用完自动清理"，但打开/清理这两步本身是异步操作的场景（比如打开一个数据库连接池）。
- `async for`：用在遍历一个"异步产出值"的对象上，对应 JS 的 `for await...of`。

## 和已有学习记录的关系

如果你在 `docs/study/education-agent-M0-学习记录.md` 里读到过第 9、10 节关于 async 的内容，那是当时带着具体练习讲的学习笔记（协程≈可暂停函数、`Promise.all`≈`asyncio.gather`、FastAPI 的 `def` 会进线程池这几条，和这篇是同一套结论）。这篇是脱离具体练习的语法参考，两者不重复展开，互相印证即可。

## 和下一篇的关系

`await` 解决的是"等一个值"，Python 里"陆续产出多个值"要靠生成器和异步生成器，这也是 Python 没有 JS `function*` 那种专门符号、容易让人困惑的地方——下一篇 [python-async-generator.md](./python-async-generator.md) 会先讲清楚这个语言差异，再讲具体语法。
