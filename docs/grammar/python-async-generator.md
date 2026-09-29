# Python 中的生成器 / 异步生成器（yield）语法

## 先讲清楚一个语言差异：Python 没有 `*` 这种生成器符号

如果你是从 [js-async-generator.md](./js-async-generator.md) 过来的，可能会以为 Python 也有类似 `function*` 那样的专门写法。**没有。**

JS 靠函数名前面的 `*` 明确标记"这是个生成器函数"，一眼能从函数签名看出来。**Python 完全不需要这个标记**——一个函数是不是生成器，纯粹取决于**函数体里有没有出现 `yield` 关键字**，函数签名和普通函数长得一模一样：

```python
def normal():
    return 1          # 普通函数，调用一次拿到 1

def generator():
    yield 1            # 函数体内出现了 yield，Python 自动把它变成生成器函数
    yield 2
```

`generator()` 和 `normal()` 定义语法上没有任何区别，都是 `def 函数名(...)`。但只要 Python 在解析函数体时发现里面有 `yield`，这个函数**从此以后就是生成器函数**，调用它永远不会立即执行函数体，而是返回一个生成器对象——这一点必须扫过整个函数体才能确定，是 Python 静态分析这段代码时做的判断，跟你有没有加什么符号无关。

这也是为什么这篇文档不叫"async 与 `*` 语法"：**Python 的生成器语法核心是 `yield` 这个关键字，不是某个符号。** 下面正式进入语法讲解。

## 普通生成器：def + yield

```python
def count_up_to(n):
    i = 1
    while i <= n:
        yield i
        i += 1

gen = count_up_to(3)
next(gen)   # 1
next(gen)   # 2
next(gen)   # 3
next(gen)   # 抛出 StopIteration
```

和 JS 的迭代器协议对应上：Python 的生成器对象自动实现了 `__iter__` 和 `__next__` 这两个方法（对应 JS 的 `Symbol.iterator` 和 `.next()`），所以能直接用在 `for` 循环里：

```python
for x in count_up_to(3):
    print(x)   # 1 2 3
```

`for` 循环消费生成器时，遇到 `StopIteration` 就自动结束循环，不会让它像上面 `next(gen)` 那样直接抛出异常。

**惰性求值**同样是生成器的核心优势：

```python
def naturals():
    i = 1
    while True:
        yield i
        i += 1

for n in naturals():
    if n > 5:
        break
    print(n)   # 1 2 3 4 5
```

`break` 之后生成器不会继续往下算，和数组/列表"必须先把所有元素都算出来才能用"完全不同。

## 异步生成器：async def + 函数体内 yield

把 `async def` 和函数体里的 `yield` 结合起来，就得到**异步生成器**——同一个函数体内可以同时用 `await`（暂停等结果）和 `yield`（暂停吐出一个值）：

```python
async def fetch_pages(url):
    next_url = url
    while next_url:
        page = await fetch(next_url)     # 等网络请求
        yield page["items"]              # 吐出这一页的数据
        next_url = page.get("next_url")
```

类型标注通常写成 `AsyncIterator[T]` 或 `AsyncGenerator[T, None]`：

```python
from collections.abc import AsyncIterator

async def fetch_pages(url: str) -> AsyncIterator[list]:
    ...
```

**再次强调**：签名上完全看不出这是异步生成器，`async def ... -> AsyncIterator[list]` 光看这一行，和一个"返回一个 AsyncIterator 对象的普通协程函数"没有任何语法上的区别，判断依据仍然只有函数体里有没有 `yield`。

## 消费端：async for

对应 JS 的 `for await...of`：

```python
async for items in fetch_pages("/api/list?page=1"):
    print(items)
```

`async for` 每次会 `await` 一次"拿下一个值"这个动作，直到异步生成器结束。

## 特例：@asynccontextmanager —— 只 yield 一次的异步生成器

这是 Python 标准库 `contextlib` 提供的一个装饰器，它的用法很特殊：**要求函数体里恰好 `yield` 一次**，把"只产出一个值"的异步生成器，转换成一个能被 `async with` 使用的**异步上下文管理器**：

```python
from contextlib import asynccontextmanager

@asynccontextmanager
async def open_resource():
    resource = await acquire()   # yield 之前：相当于 "进入" 时要做的事
    try:
        yield resource            # 把资源交给 async with 语句块使用
    finally:
        await resource.close()    # yield 之后：相当于 "退出" 时要做的清理，无论块内是否出错都会执行

async def use():
    async with open_resource() as r:
        await r.do_something()
    # 走出 async with 块，close() 已经自动被调用
```

不用它的话，你得自己实现一个类，写 `__aenter__` 和 `__aexit__` 两个方法——分别对应"进入时做什么"和"退出时做什么"。`@asynccontextmanager` 把这套模板代码压缩成了"`yield` 之前的代码是进入逻辑，`yield` 之后（包在 `try/finally` 里）的代码是退出逻辑"这一种更直观的写法。

这个模式在这个项目里被真实用来管理数据库连接池的生命周期，还被用作 FastAPI 的应用启动/关闭钩子（`lifespan`）：启动时建连接池，`yield` 之后应用开始服务请求，进程关闭时自动走到 `yield` 之后（或者 `async with` 自动退出）来清理资源。具体代码见 [project-examples.md](./project-examples.md)。

## 对照表：JS async function* vs Python async def + yield

| | JS | Python |
|---|---|---|
| 普通生成器怎么标记 | 函数名前加 `*` | 函数体内出现 `yield`，无需额外符号 |
| 异步生成器怎么标记 | `async function*` | `async def` + 函数体内 `yield`，同样无需额外符号 |
| 消费方式 | `for await (const x of gen)` | `async for x in gen` |
| 只产出一个值就退出的场景 | 没有专门语法糖，需自己写 | `@asynccontextmanager`，专门处理这种"进入-退出"模式 |
| 返回值类型标注 | `AsyncGenerator<T>` | `AsyncIterator[T]` / `AsyncGenerator[T, None]` |

## 和 project-examples.md 的关系

这篇讲的每一种写法，在这个项目里都有对应的真实代码：`async def` + `yield` 被用来把 LangGraph 的流式事件转成 SSE 帧字符串；`@asynccontextmanager` 被用来管理数据库连接池和 FastAPI 的启动/关闭。其中生产 SSE 事件的这个函数内部还用到了 [python-async.md](./python-async.md) 讲过的 `nonlocal`——一个用来计数的闭包变量。完整代码坐标见 [project-examples.md](./project-examples.md)。
