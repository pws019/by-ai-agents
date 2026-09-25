"""业务 API 客户端。一个实例只属于"一次工具调用的一个 actor"：构造时绑定 RunContext，
之后所有请求自动带上 X-Actor-Context。方法里没有任何"以谁的身份"的参数——
工具处理函数拿到的就是这个已绑定的对象，想换身份也没有入口。
"""
import httpx

from .context import RunContext

API_PREFIX = "/api/v1"


class BusinessApiError(Exception):
    """业务 API 返回了非 2xx。只保留状态码和错误码，不保留响应体/请求头，避免凭证或内部信息被带进日志或模型。"""

    def __init__(self, status: int, code: str):
        super().__init__(f"{code} ({status})")
        self.status = status
        self.code = code


class BusinessApi:
    def __init__(self, client: httpx.AsyncClient, ctx: RunContext, timeout_s: float):
        self._client = client
        self._headers = {"X-Actor-Context": ctx.token}
        self._timeout = timeout_s

    async def _request(self, method: str, path: str, **kw) -> dict:
        res = await self._client.request(
            method, f"{API_PREFIX}{path}", headers=self._headers, timeout=self._timeout, **kw
        )
        if res.status_code >= 400:
            try:
                code = res.json()["error"]["code"]
            except (ValueError, KeyError, TypeError):
                code = "UNKNOWN"
            raise BusinessApiError(res.status_code, code)
        return res.json()

    async def get(self, path: str, params: dict | None = None) -> dict:
        return await self._request("GET", path, params=params)

    async def post(self, path: str, json: dict) -> dict:
        return await self._request("POST", path, json=json)
