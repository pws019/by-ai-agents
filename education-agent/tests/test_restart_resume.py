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
    r = httpx.post(f"{BASE}/spike/{task}/start", json={"reason": "test"}).json()
    assert r["next"] == ["confirm"]
    assert r["pendingInterrupt"] == [{"type": "need_confirm", "show": "转班草稿：从 A 班转到 B 班（合成数据）"}]

    # 模拟崩溃：SIGKILL，进程内一切内存状态丢失
    server[0].send_signal(signal.SIGKILL)
    server[0].wait()
    server.append(start_server())

    r = httpx.get(f"{BASE}/spike/{task}").json()
    assert r["next"] == ["confirm"], "重启后应仍停在 confirm"
    assert r["pendingInterrupt"], "待确认的中断应仍在"

    r = httpx.post(f"{BASE}/spike/{task}/resume", json={"type": "need_confirm","value": "confirm"}).json()
    assert r["next"] == []
    assert r["values"]["outcome"] == "executed"

    # 哪些代码重跑：draft 只跑 1 次（已完成的节点不重跑），confirm 从头重跑所以 enter 两次
    log = httpx.get(f"{BASE}/spike/{task}/log").json()
    assert log == ["ask_reason", "draft", "confirm:enter", "confirm:enter", "confirm:resumed", "finalize"]


def test_resume_finished_task_conflicts_and_unknown_is_404(server):
    task = f"t-{uuid.uuid4().hex[:8]}"
    httpx.post(f"{BASE}/spike/{task}/start", json={"reason": "test"})
    httpx.post(f"{BASE}/spike/{task}/resume", json={"type": "need_confirm", "value": "cancel"})
    r = httpx.post(f"{BASE}/spike/{task}/resume", json={"type": "need_confirm","value": "confirm"})
    assert r.status_code == 409
    assert httpx.get(f"{BASE}/spike/nope-{task}").status_code == 404


def test_checkpoint_tables_live_in_dedicated_schema():
    with psycopg.connect(DATABASE_URL) as conn:
        rows = conn.execute(
            "SELECT table_schema FROM information_schema.tables WHERE table_name = 'checkpoints'"
        ).fetchall()
    assert rows == [(CHECKPOINT_SCHEMA,)]


def test_interrupt_survives_kill_and_resumes_v2(server):
    task = f"t-{uuid.uuid4().hex[:8]}"
    r = httpx.post(f"{BASE}/spike/{task}/start").json()
    assert r["next"] == ["ask_reason"]
    assert r["pendingInterrupt"] == [{"type": "need_reason", "show": "需要补充原因"}]

    # 模拟崩溃：SIGKILL，进程内一切内存状态丢失
    server[0].send_signal(signal.SIGKILL)
    server[0].wait()
    server.append(start_server())

    r = httpx.get(f"{BASE}/spike/{task}").json()
    assert r["next"] == ["ask_reason"], "重启后应仍停在 ask_reason"
    assert r["pendingInterrupt"], "待确认的中断应仍在"

    r = httpx.post(f"{BASE}/spike/{task}/resume", json={"type": "need_reason", "value": "原因是这样的：巴拉巴拉"}).json()
    assert r["next"] == ["confirm"]
    # assert r["values"]["outcome"] == "executed"

    # 哪些代码重跑：ask reason会由于缺乏原因重跑
    log = httpx.get(f"{BASE}/spike/{task}/log").json()
    assert log == ["ask_reason", "reason:enter", "ask_reason", "reason:enter", "reason:resumed","draft" ,"confirm:enter"]

def test_interrupt_survives_kill_and_resumes_v3_error_type_send(server):
    task = f"t-{uuid.uuid4().hex[:8]}"
    r = httpx.post(f"{BASE}/spike/{task}/start").json()
    assert r["next"] == ["ask_reason"]
    assert r["pendingInterrupt"] == [{"type": "need_reason", "show": "需要补充原因"}]


    resp = httpx.post(f"{BASE}/spike/{task}/resume", json={"type": "need_confirm", "value": "confirm"})
    assert resp.status_code == 409

    r = httpx.get(f"{BASE}/spike/{task}").json()
    assert r["next"] == ["ask_reason"], "失败应仍停在 ask_reason"
    assert r["pendingInterrupt"], "待确认的中断应仍在"
    
