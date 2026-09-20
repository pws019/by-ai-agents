"""T-04 验收：中断后 kill -9 服务，重启后同一 task id 恢复。真实 Postgres，不用内存存储。"""
import signal
import subprocess
import sys
import time
import uuid

import httpx
import psycopg
import pytest

from education_agent.config import CHECKPOINT_SCHEMA, DATABASE_URL

PORT = 8301
BASE = f"http://127.0.0.1:{PORT}"


def start_server() -> subprocess.Popen:
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "education_agent.app:app", "--app-dir", "src", "--port", str(PORT)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(50):
        try:
            httpx.get(f"{BASE}/openapi.json", timeout=0.5)
            return proc
        except httpx.HTTPError:
            time.sleep(0.2)
    proc.kill()
    raise RuntimeError("server did not start")


@pytest.fixture
def server():
    procs = []
    procs.append(start_server())
    yield procs
    for p in procs:
        p.kill()


def test_interrupt_survives_kill_and_resumes(server):
    task = f"t-{uuid.uuid4().hex[:8]}"
    r = httpx.post(f"{BASE}/spike/{task}/start").json()
    assert r["next"] == ["confirm"]
    assert r["pendingInterrupt"] == [{"summary": "转班草稿：从 A 班转到 B 班（合成数据）"}]

    # 模拟崩溃：SIGKILL，进程内一切内存状态丢失
    server[0].send_signal(signal.SIGKILL)
    server[0].wait()
    server.append(start_server())

    r = httpx.get(f"{BASE}/spike/{task}").json()
    assert r["next"] == ["confirm"], "重启后应仍停在 confirm"
    assert r["pendingInterrupt"], "待确认的中断应仍在"

    r = httpx.post(f"{BASE}/spike/{task}/resume", json={"decision": "confirm"}).json()
    assert r["next"] == []
    assert r["values"]["outcome"] == "executed"

    # 哪些代码重跑：draft 只跑 1 次（已完成的节点不重跑），confirm 从头重跑所以 enter 两次
    log = httpx.get(f"{BASE}/spike/{task}/log").json()
    assert log == ["draft", "confirm:enter", "confirm:enter", "confirm:resumed", "finalize"]


def test_resume_finished_task_conflicts_and_unknown_is_404(server):
    task = f"t-{uuid.uuid4().hex[:8]}"
    httpx.post(f"{BASE}/spike/{task}/start")
    httpx.post(f"{BASE}/spike/{task}/resume", json={"decision": "cancel"})
    r = httpx.post(f"{BASE}/spike/{task}/resume", json={"decision": "confirm"})
    assert r.status_code == 409
    assert httpx.get(f"{BASE}/spike/nope-{task}").status_code == 404


def test_checkpoint_tables_live_in_dedicated_schema():
    with psycopg.connect(DATABASE_URL) as conn:
        rows = conn.execute(
            "SELECT table_schema FROM information_schema.tables WHERE table_name = 'checkpoints'"
        ).fetchall()
    assert rows == [(CHECKPOINT_SCHEMA,)]
