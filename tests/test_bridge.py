import asyncio
import json
from contextlib import suppress

import httpx
import pytest

from agent_send.bridge import Bridge


async def test_grok_to_hermes_waits_for_actual_final_result(mailbox):
    store, config = mailbox
    calls = []

    def handler(req):
        calls.append(req)
        assert req.headers["authorization"] == "Bearer test-hermes-secret"
        if req.method == "POST":
            assert req.headers["idempotency-key"] == request.id
            data = json.loads(req.content)
            assert data["input"] == "question"
            assert data["session_id"] == f"agent-send-{request.id}"
            return httpx.Response(202, json={"run_id": "run_fake"})
        return httpx.Response(200, json={"status": "completed", "output": "Hermes answer"})

    request = store.submit("grok", "hermes", "question")
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await Bridge(config, store, client).deliver(request)
    assert store.result(request.id)["result"] == "Hermes answer"
    assert [r.method for r in calls] == ["POST", "GET"]


async def test_reconnect_resumes_hermes_native_run_without_new_execution(mailbox):
    store, config = mailbox
    request = store.submit("grok", "hermes", "question")
    store.update(request.id, status="running", native_run_id="run_saved")

    def handler(req):
        assert req.method == "GET" and req.url.path == "/v1/runs/run_saved"
        return httpx.Response(200, json={"status": "completed", "output": "recovered"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await Bridge(config, store, client).deliver(request)
    assert store.result(request.id)["result"] == "recovered"


async def test_hermes_to_grok_requires_callback_and_handles_callback_race(mailbox):
    store, config = mailbox
    request = store.submit("hermes", "grok", "question")

    def handler(req):
        assert req.headers["authorization"] == "Bearer test-webhook-secret"
        assert json.loads(req.content)["request_id"] == request.id
        store.finish(request.id, "Grok answer", sender="grok")
        return httpx.Response(200)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await Bridge(config, store, client).deliver(request)
    assert store.state(request.id)["status"] == "completed"
    assert store.result(request.id)["result"] == "Grok answer"


async def test_grok_ack_is_not_answer_and_restart_does_not_repost(mailbox):
    store, config = mailbox
    request = store.submit("hermes", "grok", "question")
    count = 0

    def handler(_req):
        nonlocal count
        count += 1
        return httpx.Response(200)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await Bridge(config, store, client).deliver(request)
        assert (await store.wait(request.id, 0))["status"] == "pending"
        task = asyncio.create_task(Bridge(config, store, client).run())
        await asyncio.sleep(0.13)
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
    assert count == 1


async def test_grok_has_one_outstanding_task_until_reply(mailbox):
    store, config = mailbox
    first = store.submit("hermes", "grok", "first")
    second = store.submit("hermes", "grok", "second")
    calls = []

    def handler(req):
        calls.append(json.loads(req.content)["request_id"])
        return httpx.Response(200)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        task = asyncio.create_task(Bridge(config, store, client).run())
        await asyncio.sleep(0.13)
        assert calls == [first.id]
        store.finish(first.id, "answer", sender="grok")
        await asyncio.sleep(0.13)
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
    assert calls == [first.id, second.id]


@pytest.mark.parametrize("kind", ["hermes", "grok"])
async def test_lost_submission_receipt_becomes_unknown_not_retry(mailbox, kind):
    store, config = mailbox
    request = store.submit("grok" if kind == "hermes" else "hermes", kind, "question")
    count = 0

    def handler(req):
        nonlocal count
        count += 1
        raise httpx.ReadTimeout("upstream-secret-must-not-leak", request=req)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        bridge = Bridge(config, store, client)
        await bridge.deliver(request)
        assert store.state(request.id)["status"] == "unknown"
        assert "upstream-secret" not in json.dumps(store.state(request.id))
        task = asyncio.create_task(Bridge(config, store, client).run())
        await asyncio.sleep(0.12)
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
    assert count == 1


async def test_grok_dispatching_after_crash_is_not_replayed(mailbox):
    store, config = mailbox
    request = store.submit("hermes", "grok", "question")
    store.update(request.id, status="dispatching")

    def handler(_req):
        pytest.fail("uncertain webhook must not be replayed")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        task = asyncio.create_task(Bridge(config, store, client).run())
        await asyncio.sleep(0.1)
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
    assert store.state(request.id)["status"] == "unknown"
