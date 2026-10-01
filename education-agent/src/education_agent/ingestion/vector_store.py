"""Qdrant 封装：只暴露索引任务需要的四个操作，不是通用客户端。payload 字段按 design.md §6
的最低要求（sourceId、sourceVersion、cohortId、visibility、lessonId、segmentId），
多带 content/startMs/endMs 是为了 T-27 检索时直接出引用文本，不用再回查 Postgres。

point id 用 segment 的 UUID：同一个 segment 不管索引任务重跑多少次，upsert 到的都是同一个
点位，不会因为失败重跑而堆出重复向量——这是"失败重跑无重复数据"在向量库这一侧的保证。
"""
from dataclasses import dataclass

from qdrant_client import AsyncQdrantClient, models


@dataclass(frozen=True)
class SegmentPoint:
    segment_id: str
    vector: list[float]
    document_id: str
    document_version: int
    lesson_id: str
    cohort_id: str
    visibility: str
    content: str
    start_ms: int | None
    end_ms: int | None


class DimensionMismatch(Exception):
    """同名 collection 之前用了维度不同的 embedding 模型建的（比如换了模型没改 collection 名字）。
    不处理、不新建：collection 名字被另一个维度的数据占着，这是需要人介入决定的事，不是程序能
    安全自动纠正的——在 ensure_collection 这一步就报清楚，不要留给 upsert 时才报一个不好懂的
    "vector dimension error"。"""


class VectorStore:
    def __init__(self, client: AsyncQdrantClient, collection: str, dimension: int):
        self._client = client
        self._collection = collection
        self._dimension = dimension

    async def ensure_collection(self) -> None:
        if not await self._client.collection_exists(self._collection):
            await self._client.create_collection(
                self._collection, vectors_config=models.VectorParams(size=self._dimension, distance=models.Distance.COSINE)
            )
            # payload 索引：sourceId/cohortId/lessonId/visibility 是查询（count/delete/T-27 的权限过滤）
            # 实际会按等值匹配的字段，相当于给表的 WHERE 列建索引——数据量小时没有它也能跑，量大后
            # 不建索引就是全表扫描。只在新建时建一次：已存在的 collection 不重复建（create_payload_index
            # 本身是幂等的，但没必要每次 ensure_collection 都发一轮请求）。
            for field in ("sourceId", "cohortId", "lessonId", "visibility"):
                await self._client.create_payload_index(self._collection, field_name=field, field_schema=models.PayloadSchemaType.KEYWORD)
            return

        info = await self._client.get_collection(self._collection)
        existing_size = info.config.params.vectors.size
        if existing_size != self._dimension:
            raise DimensionMismatch(
                f"collection {self._collection!r} 已存在且维度是 {existing_size}，跟当前 embedding 模型的 "
                f"{self._dimension} 维不一致——很可能是换过 embedding 模型但 collection 名字没换"
            )

    async def upsert(self, points: list[SegmentPoint]) -> None:
        if not points:
            return
        await self._client.upsert(
            self._collection,
            points=[
                models.PointStruct(
                    id=p.segment_id,
                    vector=p.vector,
                    payload={
                        "sourceId": p.document_id,
                        "sourceVersion": p.document_version,
                        "cohortId": p.cohort_id,
                        "visibility": p.visibility,
                        "lessonId": p.lesson_id,
                        "segmentId": p.segment_id,
                        "content": p.content,
                        "startMs": p.start_ms,
                        "endMs": p.end_ms,
                    },
                )
                for p in points
            ],
        )

    async def count_by_document(self, document_id: str) -> int:
        result = await self._client.count(
            self._collection,
            count_filter=models.Filter(must=[models.FieldCondition(key="sourceId", match=models.MatchValue(value=document_id))]),
        )
        return result.count

    async def delete_by_document(self, document_id: str) -> None:
        await self._client.delete(
            self._collection,
            points_selector=models.FilterSelector(
                filter=models.Filter(must=[models.FieldCondition(key="sourceId", match=models.MatchValue(value=document_id))])
            ),
        )

    async def fetch_vectors(self, segment_ids: list[str]) -> dict[str, list[float]]:
        """按 segment id 批量取回已存在的向量；不存在的 id 不会出现在返回的字典里（不报错）。
        供索引任务判断"上一版本里内容没变的 segment，向量能不能直接搬过来用"。
        """
        if not segment_ids:
            return {}
        points = await self._client.retrieve(self._collection, ids=segment_ids, with_vectors=True)
        return {str(p.id): p.vector for p in points if p.vector is not None}
