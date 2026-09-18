import copy
import json
import unittest
from unittest.mock import patch
from datetime import datetime, timedelta, timezone
import worker


def sample():
    now = datetime.now(timezone.utc)
    return {"requestId": "test-job", "role": "verifier", "mode": "DEMO", "station": "역삼", "direction": "내선",
            "attempt": 0, "collectionHealthy": True, "freshSeconds": 180, "now": now.isoformat(),
            "observations": [{"id": f"o{i}", "mode": "DEMO", "station": "역삼", "direction": "내선", "trainId": "T1",
                              "position": "역삼", "etaSeconds": 180+i*60, "generatedAt": (now-timedelta(seconds=(2-i)*60)).isoformat()}
                             for i in range(3)]}


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.job = sample()

    @patch.object(worker, "ROLE", "verifier")
    @patch.object(worker, "OPENAI_KEY", "")
    def test_demo_requests_refresh_then_allows(self):
        self.assertEqual("NEEDS_MORE_DATA", worker.analyze(self.job)["verdict"])
        self.job["attempt"] = 1
        self.assertEqual("ALERT_ALLOWED", worker.analyze(self.job)["verdict"])

    def test_stale_duplicate_and_identity_mismatch(self):
        self.job["now"] = (datetime.now(timezone.utc)+timedelta(minutes=15)).isoformat()
        self.assertFalse(worker.assess(self.job)["fresh"])
        job = sample()
        job["observations"] = [job["observations"][0]] * 3
        self.assertFalse(worker.assess(job)["candidate"])
        job = sample()
        for i, row in enumerate(job["observations"]):
            row["trainId"] = str(i)
        self.assertFalse(worker.assess(job)["candidate"])

    def test_other_train_does_not_hide_delay(self):
        self.job["observations"].append(dict(self.job["observations"][-1], id="other", trainId="T2"))
        self.assertTrue(worker.assess(self.job)["candidate"])

    def test_invented_evidence_is_rejected(self):
        with self.assertRaises(ValueError):
            worker.validate_decision({"verdict": "ALERT_ALLOWED", "reason": "test", "evidenceIds": ["fake"]}, self.job, worker.assess(self.job), {"read_observations", "check_freshness"})

    @patch.object(worker, "ROLE", "verifier")
    @patch.object(worker, "OPENAI_KEY", "")
    def test_live_never_silently_simulates(self):
        self.job["mode"] = "LIVE"
        for row in self.job["observations"]:
            row["mode"] = "LIVE"
        with self.assertRaises(RuntimeError):
            worker.analyze(self.job)

    @patch.object(worker, "ROLE", "verifier")
    @patch.object(worker, "OPENAI_KEY", "unit-test-placeholder")
    def test_real_tool_protocol_with_mock_openai(self):
        calls = ["read_observations", "check_freshness", "request_refresh", "submit_decision"]
        arguments = [{}, {}, {}, {"verdict": "NEEDS_MORE_DATA", "reason": "최신 관측 재조회 필요", "evidenceIds": ["o0", "o1", "o2"]}]
        class Response:
            def __init__(self, payload): self.payload = payload
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, _): return json.dumps(self.payload).encode()
        responses = [Response({"output": [{"type": "function_call", "call_id": f"call{i}", "name": name, "arguments": json.dumps(arguments[i])}]}) for i, name in enumerate(calls)]
        with patch("urllib.request.urlopen", side_effect=responses) as mocked:
            result = worker.analyze(self.job)
        self.assertEqual("openai", result["engine"])
        self.assertEqual("NEEDS_MORE_DATA", result["verdict"])
        self.assertEqual(4, mocked.call_count)
        last = json.loads(mocked.call_args[0][0].data)
        self.assertFalse(last["store"])
        self.assertEqual(3, len([i for i in last["input"] if i.get("type") == "function_call_output"]))


if __name__ == "__main__":
    unittest.main()
