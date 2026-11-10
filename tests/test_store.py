import asyncio
import os

import pytest

from agent_send.store import MailError, Store, atomic_json


def test_idempotent_submission_and_conflicting_retry(mailbox):
    store, _ = mailbox
    a = store.submit("hermes", "grok", "question", key="retry")
    assert store.submit("hermes", "grok", "question", key="retry").id == a.id
    with pytest.raises(MailError, match="different request"):
        store.submit("hermes", "grok", "another question", key="retry")
    assert len(list(store.requests())) == 1


async def test_reply_correlation_and_restart(mailbox):
    store, _ = mailbox
    a = store.submit("hermes", "grok", "first")
    b = store.submit("hermes", "grok", "second")
    store.update(a.id, status="awaiting_reply")
    store.update(b.id, status="awaiting_reply")
    store.finish(b.id, "answer second", sender="grok")
    assert (await store.wait(a.id, 0))["status"] == "pending"
    store.finish(a.id, "answer first", sender="grok")
    reopened = Store(store.root)
    assert (await reopened.wait(a.id, 0))["result"] == "answer first"
    assert reopened.result(b.id)["result"] == "answer second"


def test_permissions_traversal_and_duplicate_callbacks(mailbox):
    store, _ = mailbox
    request = store.submit("hermes", "grok", "question")
    store.update(request.id, status="awaiting_reply")
    with pytest.raises(MailError, match="assigned"):
        store.finish(request.id, "forged", sender="hermes")
    with pytest.raises(MailError, match="not found"):
        store.result(request.id, sender="grok")
    with pytest.raises(MailError, match="invalid request ID"):
        store.result("../../secrets")
    store.finish(request.id, "answer", sender="grok")
    store.finish(request.id, "answer", sender="grok")
    with pytest.raises(MailError, match="different result"):
        store.finish(request.id, "changed", sender="grok")
    # A POST acknowledgment arriving after the callback cannot regress completion.
    store.update(request.id, status="awaiting_reply")
    assert store.state(request.id)["status"] == "completed"


def test_circular_wait_and_completed_exchange(mailbox):
    store, _ = mailbox
    request = store.submit("hermes", "grok", "question")
    with pytest.raises(MailError, match="circular"):
        store.submit("grok", "hermes", "call back")
    store.update(request.id, status="awaiting_reply")
    store.finish(request.id, "done", sender="grok")
    assert store.submit("grok", "hermes", "independent next question")


async def test_expired_request_preserves_late_reply(mailbox):
    store, _ = mailbox
    request = store.submit("hermes", "grok", "question")
    store.update(request.id, status="expired")
    store.finish(request.id, "late answer", sender="grok")
    result = await store.wait(request.id, 0)
    assert result["status"] == "expired"
    assert result["late"] and result["result"] == "late answer"


def test_half_written_invalid_and_symlink_records_are_not_dispatched(mailbox, tmp_path):
    store, _ = mailbox
    (store.root / "requests" / ".tmp-unfinished").write_text('{"message":')
    (store.root / "requests" / ("r_" + "a" * 32 + ".json")).write_text("broken")
    outside = tmp_path / "outside.json"
    outside.write_text("{}")
    (store.root / "requests" / ("r_" + "b" * 32 + ".json")).symlink_to(outside)
    good = store.submit("hermes", "grok", "valid")
    assert [r.id for r in store.requests()] == [good.id]
    atomic_json(store.path("state", good.id), {"status": "nonsense"})
    assert list(store.requests()) == []


def test_private_files_and_single_bridge_owner(mailbox):
    store, _ = mailbox
    request = store.submit("hermes", "grok", "question")
    assert os.stat(store.path("requests", request.id)).st_mode & 0o777 == 0o600
    with store.bridge_lock(), pytest.raises(MailError, match="already owns"):
        with store.bridge_lock():
            pass


@pytest.mark.parametrize("deadline", [0, float("inf"), float("nan"), 3601])
def test_invalid_deadlines(mailbox, deadline):
    store, _ = mailbox
    with pytest.raises(MailError):
        store.submit("hermes", "grok", "question", deadline=deadline)


async def test_wait_cancellation_does_not_cancel_request(mailbox):
    store, _ = mailbox
    request = store.submit("hermes", "grok", "question")
    task = asyncio.create_task(store.wait(request.id, 20))
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert store.state(request.id)["status"] == "queued"


def test_maximum_escaped_message_roundtrips(mailbox):
    store, _ = mailbox
    request = store.submit("hermes", "grok", "\x00" * 32_768)
    assert store.request(request.id).message == request.message


def test_committed_reply_is_authority_after_crash_before_state_update(mailbox):
    store, _ = mailbox
    request = store.submit("hermes", "grok", "question")
    store.update(request.id, status="awaiting_reply")
    store.finish(request.id, "answer", sender="grok")
    # Simulate a crash between committing the reply and committing execution state.
    atomic_json(store.path("state", request.id), {"status": "awaiting_reply"})
    assert store.result(request.id)["status"] == "completed"
    assert store.submit("grok", "hermes", "next exchange")
