# Python 常用语法：list / dict / tuple / set 等内置对象

前 4 篇讲的是异步（[python-async.md](./python-async.md)、[python-async-generator.md](./python-async-generator.md)）。这篇往回退一步，讲 Python 里天天在用、但容易一知半解的几个内置容器类型：`list`、`tuple`、`dict`、`set`、`str`，以及围绕它们的推导式、解包、常见坑。这篇不依赖 async 知识，读前面几篇之前先看这篇也可以。

所有例子优先用这个项目 `education-agent/src/education_agent/dev_model.py` 里的真实代码——它是一个不依赖真实模型的规则引擎（mock 版对话逻辑），短小但几乎把常用的容器语法用了个遍，非常适合当例子来源。

## 类型总览：先分清"能不能改"

| 类型 | 有序 | 能否修改（mutable） | 能否重复 | 典型写法 |
|---|---|---|---|---|
| `list` | 是 | 能 | 能 | `[1, 2, 3]` |
| `tuple` | 是 | **不能** | 能 | `(1, 2, 3)` |
| `dict` | 是（插入顺序） | 能 | key 不能重复 | `{"a": 1}` |
| `set` | 否 | 能 | **不能**（自动去重） | `{1, 2, 3}` |
| `str` | 是 | **不能** | — | `"hello"` |

**能不能改**是选择用哪种类型时最重要的判断依据：需要"这份数据以后不会被意外改动"（比如函数参数的默认值、字典的 key），就该用不可变类型（`tuple`、`str`、数字），后面"常见的坑"一节会讲为什么这件事很重要。

## list：有序、可变的序列

### 创建、索引、切片（slicing）

```python
items = [10, 20, 30, 40, 50]
items[0]      # 10，从 0 开始
items[-1]     # 50，负数从末尾数，-1 是最后一个
items[1:3]    # [20, 30]，切片是"左闭右开"：包含下标 1，不包含下标 3
items[:3]     # [10, 20, 30]，省略起点＝从头开始
items[3:]     # [40, 50]，省略终点＝到末尾
items[::2]    # [10, 30, 50]，第三个参数是步长（step）
items[::-1]   # [50, 40, 30, 20, 10]，步长为负＝反转
```

这个项目里，切片常用来"取前几个"或"截断过长的字符串"：

```python
# education-agent/src/education_agent/dev_model.py:169
titles = "、".join(f"「{l['title']}」" for l in lessons[:3])   # 只取前 3 节课的标题

# education-agent/src/education_agent/dev_model.py:143
"reason": turn.text.strip()[:2000]   # 原因文本截断到 2000 字，防止超长
```

还有"取某个下标之后的所有元素"，用在只看"最后一轮用户消息之后发生的事"：

```python
# education-agent/src/education_agent/dev_model.py:67
for m in messages[last_user:]:
    ...
```

### 常用方法

```python
items = [3, 1, 2]
items.append(4)      # [3, 1, 2, 4]，末尾追加一个
items.extend([5, 6])  # [3, 1, 2, 4, 5, 6]，追加多个（区别于 append([5, 6]) 会把整个列表当一个元素塞进去）
items.pop()            # 弹出并返回最后一个元素，原列表少一个
items.sort()           # 原地排序，改的是原列表，返回 None
sorted(items)          # 不改原列表，返回一个新的已排序列表——这是和 .sort() 的关键区别
```

### 列表推导式（list comprehension）

比 `for` 循环 + `.append()` 更紧凑的写法：

```python
squares = [x * x for x in range(5)]           # [0, 1, 4, 9, 16]
evens = [x for x in range(10) if x % 2 == 0]  # 带条件过滤：[0, 2, 4, 6, 8]
```

项目里一个带三元表达式（`条件 ? A : B` 的 Python 写法是 `A if 条件 else B`）的例子：

```python
# education-agent/src/education_agent/dev_model.py:161
parts = [f"{e['cohort']['name']}（{'在读' if e['status'] == 'active' else '已结束'}）" for e in items]
```

推导式里的表达式部分（`for` 前面那段）本身又是个 f-string，f-string 内部又嵌了一个三元表达式——层层嵌套但仍然可读，这是列表推导式的典型用法：**产出的是一个新列表，每一项都经过同一个变换规则**。

另一个例子，`ToolOutput` 的 `data` 里把一批工具返回的原始数据统一"瘦身"：

```python
# education-agent/src/education_agent/tools/contracts.py:75-76
async def _application_status(api: BusinessApi, a: ApplicationStatusArgs) -> ToolOutput:
    if a.applicationId is None:
        page = await api.get("/me/applications")
        return ToolOutput({"items": [_status_view(x) for x in page["items"]]})
```

## tuple：不可变的序列

`tuple` 和 `list` 几乎一样能索引、切片，唯一但关键的区别是**不可变**——创建之后不能增删改元素：

```python
point = (3, 4)
point[0] = 5   # 报错：TypeError，tuple 不支持项赋值
```

### 什么时候该用 tuple 而不是 list

- **数据本身是"一组固定搭配"，以后不会再变动**。这个项目里，一批固定不变的工具规格：

  ```python
  # education-agent/src/education_agent/tools/contracts.py:85
  TOOL_SPECS: tuple[ToolSpec, ...] = (...)
  ```

  类型标注 `tuple[ToolSpec, ...]` 里的 `...` 表示"任意数量个 `ToolSpec`，但整体不可变"，用 `tuple` 强调这份清单在运行期不会被谁悄悄改动。

- **需要当字典的 key**（下面 dict 那节会讲：key 必须不可变，`list` 不行，`tuple` 可以）。
- **函数一次要返回好几个值**：Python 没有"多返回值"这个专门语法，其实是自动打包成了一个 tuple：

  ```python
  def min_max(nums):
      return min(nums), max(nums)   # 打包成 (min值, max值)

  lo, hi = min_max([3, 1, 4, 1, 5])  # 解包，见下一节
  ```

### 解包（unpacking）

```python
a, b = (1, 2)              # a=1, b=2
a, *rest = [1, 2, 3, 4]    # a=1, rest=[2, 3, 4]，* 收集"剩下的所有"
for words, tool in ((("课表",), "getMySchedule"), (("进度",), "getMyProgress")):
    ...
```

项目里一个把"一组关键词"和"该调用的工具名"配对、逐个解包匹配的例子：

```python
# education-agent/src/education_agent/dev_model.py:108-112
wanted = next((tool for words, tool in (
    (("课表", "课程表", "上课", "下节课"), "getMySchedule"),
    (("进度", "学到哪"), "getMyProgress"),
    (("可转", "转入", "班期"), "getTransferTargets"),
) if any(w in t for w in words)), None)
```

这是一个**元组套元组**的结构：外层是"若干条规则"，每条规则本身是 `(关键词元组, 工具名)` 这样一对。`for words, tool in (...)` 在遍历外层元组的同时，把每一条规则**当场解包**成 `words` 和 `tool` 两个变量。这一整段还嵌套了一个生成器表达式（`tool for ... if ...`）配合 `next(..., None)`——"找第一个满足条件的，找不到就返回 `None`"，是 Python 里很常见的写法，等价于其他语言里的 `find`。

## dict：键值对的映射

### 创建、访问

```python
user = {"name": "小明", "role": "student"}
user["name"]          # "小明"，key 不存在会抛 KeyError
user.get("age")        # None，key 不存在时返回 None，不报错
user.get("age", 0)     # 0，指定找不到时的默认值
"name" in user          # True，判断 key 是否存在，不是判断 value
```

**`[]` 和 `.get()` 的选择准则**：确定这个 key 一定存在（不存在就是 bug，应该报错让你发现），用 `[]`；key 可能不存在，且"不存在"是正常情况，用 `.get()`。

```python
# education-agent/src/education_agent/dev_model.py:63
self.calls_in_history = sum(len(m.get("tool_calls", [])) for m in messages if m["role"] == "assistant")
```

这里用 `.get("tool_calls", [])` 是因为不是每条 assistant 消息都带 `tool_calls` 字段，缺失时按"空列表"处理，`len([])` 是 0，不会打断求和。

### 遍历

```python
for key in user:              # 默认遍历 key
    ...
for key, value in user.items():  # 同时拿到 key 和 value，最常用
    ...
for value in user.values():
    ...
```

```python
# education-agent/src/education_agent/dev_model.py:80
return any(not r.get("ok") for r in self.results.values())
```

`.values()` 只关心值本身（这里是每次工具调用的结果），配合 `any()`——"只要有一个是 falsy 就返回 True"——判断"是否有任意一次调用失败"。

### 字典推导式（dict comprehension）

```python
squared_map = {x: x * x for x in range(5)}   # {0: 0, 1: 1, 2: 4, 3: 9, 4: 16}
```

项目里两个例子。第一个是"从一批固定的字段名，逐个去环境变量里取值"：

```python
# education-agent/src/education_agent/main.py:53-54
fields = {"model_base_url": "MODEL_BASE_URL", "model_api_key": "MODEL_API_KEY", "model_name": "MODEL_NAME"}
model = {k: env.get(v, "") for k, v in fields.items()}
```

第二个是"只挑选字典里几个感兴趣的 key，其余的丢掉"——一种常见的"数据瘦身"写法：

```python
# education-agent/src/education_agent/tools/contracts.py:82
def _status_view(app: dict) -> dict:
    return {k: app.get(k) for k in ("id", "type", "status", "executionStatus", "revision", "summary")}
```

这里 `for k in (...)` 遍历的是一个写死的字段名元组（前面刚讲过：固定不变的一组值，用 tuple），对每个字段名去原字典里 `.get()` 一次，组出一个只含这几个字段的新字典。

还有一个**更复杂的嵌套推导式**，一次 `for` 循环里套了两层：

```python
# education-agent/src/education_agent/dev_model.py:65
names = {c["id"]: c["name"] for m in messages[last_user:] if m["role"] == "assistant" for c in m.get("tool_calls", [])}
```

拆开读：外层 `for m in messages[last_user:] if m["role"] == "assistant"` 先筛出"最后一轮用户消息之后的、由 assistant 发出"的消息；对每条这样的消息，内层 `for c in m.get("tool_calls", [])` 再遍历它包含的每个工具调用；最终收集出 `{调用id: 工具名}` 这样一个映射。**两层 `for` 写在同一行里，等价于两层嵌套的普通 `for` 循环**，读起来的顺序和写普通嵌套循环时的顺序一致（先写外层，再写内层）。

### 合并 / 解包：`**`

```python
base = {"a": 1, "b": 2}
merged = {**base, "b": 20, "c": 3}   # {"a": 1, "b": 20, "c": 3}，后面的同名 key 覆盖前面的
```

项目里两处："在已有参数基础上，追加/覆盖一个字段"：

```python
# education-agent/src/education_agent/dev_model.py:152
return turn.call("prepareApplication", {**args, "targetCohortId": targets[0]["cohortId"]})

# education-agent/src/education_agent/graphs/student_graph.py:106
return {**fresh, "stop_reason": "auth_expired"}
```

`**` 用在函数调用括号里，则是把一个字典"展开"成一堆关键字参数：

```python
# education-agent/src/education_agent/main.py:64-66
return Settings(
    mode=mode, internal_secret=secret, business_api_url=env.get("BUSINESS_API_URL", "http://127.0.0.1:8400"),
    host=env.get("AGENT_HOST", "127.0.0.1"), port=port, **model,
)
```

`**model` 把 `model` 这个字典里的每个键值对，展开成 `键=值` 的形式传给函数——等价于把字典里有的字段，一个个手写成关键字参数。

### 用 dict 当"分发表"代替 if/elif 链

这是个值得单独拎出来的技巧。`dict` 的 value 可以是函数本身，不只是普通数据：

```python
# education-agent/src/education_agent/dev_model.py:124
return {"getMySchedule": _schedule_text, "getMyProgress": _progress_text, "getTransferTargets": _targets_text}[wanted](data)
```

`wanted` 是一个字符串（工具名），`{...}[wanted]` 先按这个字符串从字典里查出对应的函数，再立刻用 `(data)` 调用它。等价的、但更啰嗦的写法是：

```python
if wanted == "getMySchedule":
    return _schedule_text(data)
elif wanted == "getMyProgress":
    return _progress_text(data)
elif wanted == "getTransferTargets":
    return _targets_text(data)
```

**分支越多，`dict` 分发表的优势越明显**：新增一种情况只需要在字典里加一行，不用在一长串 `if/elif` 里找地方插入；查找也是 O(1) 的哈希查找，而不是逐个 `if` 比较到底。

## set：无序、自动去重的集合

```python
tags = {"a", "b", "a", "c"}   # {"a", "b", "c"}，重复的 "a" 自动被丢弃
tags.add("d")
"a" in tags                    # True，成员判断是 set 最常见的用途，比在 list 里判断 in 更快
```

集合运算：

```python
a = {1, 2, 3}
b = {2, 3, 4}
a & b   # {2, 3}，交集
a | b   # {1, 2, 3, 4}，并集
a - b   # {1}，差集（在 a 但不在 b）
```

项目里用 `set` 表达"一批不重复的、只关心'在不在里面'的白名单"：

```python
# education-agent/src/education_agent/graphs/student_graph.py:43-44
QUERY_TOOLS = {"getCurrentOffering", "getMyEnrollment", "getMySchedule", "getMyProgress", "getTransferTargets", "getApplicationStatus"}
APPLICATION_TOOLS = {"getMyEnrollment", "getTransferTargets", "prepareApplication", "getApplicationStatus"}
```

这两个白名单只会被拿去做"这个工具名在不在允许列表里"的判断，从不需要顺序、也不会有重复项——用 `set` 比用 `list` 更准确地表达了这层意图，成员判断的性能也更好。

再看一个"边遍历边往 `set` 里加"的例子：

```python
# education-agent/src/education_agent/model/langchain_adapter.py:97
bad: set[str] = set()
for chunk in getattr(ai, "tool_call_chunks", None) or []:
    raw = chunk.get("args") or ""
    if not raw.strip():
        ...
```

`set[str] = set()` 是"先声明类型、再创建一个空集合"——**注意空集合必须写成 `set()`，不能写 `{}`**，`{}` 在 Python 里是空字典，这是个常见的手滑点。

## str：不可变的字符序列

字符串支持和 `list` 一样的索引、切片语法（`s[0]`、`s[1:3]`、`s[::-1]`），但**不可变**——`s[0] = "x"` 会报错，任何"修改"字符串的操作，实际上都是**创建了一个新字符串**。

常用方法：

```python
"  hello  ".strip()          # "hello"，去掉首尾空白
"a,b,c".split(",")            # ["a", "b", "c"]，拆成列表
"、".join(["a", "b", "c"])   # "a、b、c"，用指定分隔符把列表拼成字符串（和 split 互为逆操作）
```

`.join()` 的参数不一定要是列表，**任何可迭代对象都行**，包括生成器表达式，不需要先转成列表：

```python
# education-agent/src/education_agent/dev_model.py:169
titles = "、".join(f"「{l['title']}」" for l in lessons[:3])
```

这里 `f"「{l['title']}」" for l in lessons[:3]` 是一个生成器表达式（没有 `[]` 包裹的推导式），`.join()` 会自己逐个取值，不需要先在内存里攒出一个完整的列表——这一点会在下一节和 `python-async-generator.md` 讲过的惰性求值联系起来。

**f-string**（格式化字符串字面量）是这个项目里拼字符串最常用的方式：

```python
f"你共有 {len(items)} 个报名：" + "、".join(parts) + "。"
```

`{}` 里可以放任意表达式，不只是变量名，包括函数调用、下标访问、甚至前面提到的三元表达式。

## 生成器表达式 vs 列表推导式

把列表推导式的 `[]` 换成 `()`，就变成了生成器表达式：

```python
squares_list = [x * x for x in range(1000000)]   # 立刻算出 100 万个值，占用对应的内存
squares_gen  = (x * x for x in range(1000000))    # 不立刻算，只有真的取值时才算一个吐一个
```

项目里出现的几处 `sum(...)`、`any(...)`、`next(...)` 括号里的推导式，其实都是省略了外层括号的生成器表达式（Python 允许在函数调用时省略一层括号）：

```python
# education-agent/src/education_agent/dev_model.py:60
last_user = max(i for i, m in enumerate(messages) if m["role"] == "user")
# 等价于 max((i for i, m in enumerate(messages) if m["role"] == "user"))

# education-agent/src/education_agent/dev_model.py:84
return next(m["content"] for m in reversed(messages) if m["role"] == "user")
```

这几个场景（`max`/`sum`/`any`/`next`）都只需要"边算边用、算出结果就不用再要更多值了"，用生成器表达式比先造一个完整列表更省内存、也更快停下来——这正是 [python-async-generator.md](./python-async-generator.md) 里"惰性求值"的同步版本：生成器表达式和 `def` + `yield` 定义的生成器函数，产出的是同一类对象，只是一个用表达式语法、一个用函数体语法。

## 常见的坑

### 1. 可变默认参数（mutable default argument）

```python
def add_item(item, bucket=[]):   # 危险：默认值只会被创建一次，不是每次调用都创建新的
    bucket.append(item)
    return bucket

add_item(1)   # [1]
add_item(2)   # [1, 2] ！不是想象中的 [2]，因为两次调用共用了同一个默认列表
```

函数定义时，默认参数的值**只会被求值一次**，之后每次调用不传这个参数，用的都是**同一个对象**。如果这个默认值是可变的（`list`、`dict`、`set`），前一次调用对它的修改会"泄漏"到下一次调用。

正确写法是用 `None` 当默认值，函数体内再判断：

```python
def add_item(item, bucket=None):
    if bucket is None:
        bucket = []
    bucket.append(item)
    return bucket
```

### 2. `is` 和 `==` 不是一回事

`==` 比较**值**是否相等，`is` 比较**是不是同一个对象**（内存地址是否相同）：

```python
a = [1, 2, 3]
b = [1, 2, 3]
a == b   # True，值相等
a is b   # False，是两个不同的列表对象

a is a    # True
```

`None`、`True`、`False` 因为全局只有唯一一份，判断它们**必须**用 `is`，不用 `==`（虽然 `== None` 通常也能得到正确结果，但 `is None` 才是符合语言习惯、且性能更好的写法）：

```python
if value is None:   # 推荐
    ...
```

### 3. 浅拷贝 vs 深拷贝

```python
original = {"items": [1, 2, 3]}
shallow = original.copy()          # 或 dict(original)、{**original}
shallow["items"].append(4)
original["items"]   # [1, 2, 3, 4] ！shallow 和 original 内部的 list 是同一个对象
```

`.copy()`（以及 `{**d}`、`list(l)` 这类写法）都是**浅拷贝**：只复制最外层的容器，容器内部嵌套的可变对象仍然是**同一个引用**，改其中一份会影响另一份。真正需要"完全独立、改一份不影响另一份"，要用标准库的 `copy.deepcopy`：

```python
import copy
deep = copy.deepcopy(original)
```

### 4. 字典和集合的 key 必须"可哈希"（hashable）

```python
d = {[1, 2]: "value"}   # 报错：TypeError: unhashable type: 'list'
d = {(1, 2): "value"}   # 可以，tuple 是不可变的，可以当 key
```

这也是前面 tuple 那节说的"tuple 可以当字典 key，list 不行"的根本原因：**可变对象不可哈希，不能当字典的 key 或集合的元素**，只有不可变类型（数字、字符串、tuple、`frozenset`）才行。

## 结构化数据：dict 还是更"正式"的类型？

用 `dict` 存结构化数据很方便，但字段名全靠约定，写错一个字符串（比如 `d["stauts"]`）不会在写代码时被发现，只会在运行时炸出 `KeyError`。这个项目里，凡是"结构固定、后续会被大量读取"的数据，会换成更正式的类型：

**`TypedDict`**：长得还是一个 `dict`，运行时行为和普通字典完全一样，但类型检查工具（如 IDE、mypy）能在你写错字段名时**在编辑器里就标红**，不用等运行时报错：

```python
# education-agent/src/education_agent/graphs/student_graph.py:82-87
class GraphState(TypedDict, total=False):
    messages: Annotated[list[Message], operator.add]
    branch: str
    stop_reason: str
    reply: str
    confirmation: dict | None
```

**`@dataclass(frozen=True)`**：不再是字典，是一个真正的类，属性用 `.` 访问（不是 `["key"]`），`frozen=True` 让它创建后**不能被修改**（赋值会直接报错），适合"一次性构造好、之后只读"的场景：

```python
# education-agent/src/education_agent/tools/context.py
@dataclass(frozen=True)
class RunContext:
    actor_id: str
    role: str
    request_id: str
    expires_at: int
    token: str
```

**怎么选**：临时拼凑、结构不固定、要经过 `json.dumps` 序列化传输的数据，用 `dict`（这个项目里 LangGraph 的状态、发给模型的消息都是 `dict`，因为它们要能被存进数据库、转成 JSON）；结构固定、需要类型检查兜底、不要求可 JSON 序列化的，用 `TypedDict` 或 `dataclass`。

## 项目实例索引

| 语法点 | 文件位置 |
|---|---|
| 切片取前 N 个 / 截断字符串 | `dev_model.py:169`、`dev_model.py:143` |
| 遍历切片之后的部分 | `dev_model.py:67` |
| 列表推导式 + 三元表达式 | `dev_model.py:161` |
| 生成器表达式配合 `max`/`sum`/`next` | `dev_model.py:60`、`63`、`84` |
| `.get()` 带默认值 | `dev_model.py:63` |
| `.values()` 配合 `any()` | `dev_model.py:80` |
| 嵌套字典推导式（两层 for） | `dev_model.py:65` |
| 元组解包 + 生成器表达式找第一个匹配 | `dev_model.py:108-112` |
| dict 当分发表代替 if/elif | `dev_model.py:124` |
| dict 合并/覆盖 `{**a, ...}` | `dev_model.py:152`、`student_graph.py:106` |
| `**dict` 展开成关键字参数 | `main.py:66` |
| 固定不变的 tuple 常量 | `tools/contracts.py`（`TOOL_SPECS: tuple[ToolSpec, ...]`） |
| set 当白名单用 | `graphs/student_graph.py:43-44` |
| 空集合的正确写法 `set()` | `model/langchain_adapter.py:97` |
| `TypedDict` | `graphs/student_graph.py:82-87`（`GraphState`） |
| `@dataclass(frozen=True)` | `tools/context.py`（`RunContext`） |

## 和其他篇的关系

生成器表达式（这篇讲的 `(x for x in ...)`）和 [python-async-generator.md](./python-async-generator.md) 讲的 `async def` + `yield` 生成器函数，产出的是同一类"惰性、按需产出值"的对象，只是同步和异步的区别。如果你还没读过 async 系列，读完这篇再回去看 [python-async.md](./python-async.md)，会更容易理解"协程对象"和这里的"生成器对象"在"调用/创建时不会立即执行，需要外部驱动"这一点上是相通的。
