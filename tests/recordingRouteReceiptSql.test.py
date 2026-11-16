import re
import sqlite3
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "src/services/recordingRouteReceiptCore.ts").read_text()
SCHEMA = re.search(r"RECORDING_ROUTE_RECEIPT_SCHEMA = `([^`]+)`", SOURCE).group(1)
APPEND = re.search(r"db.runAsync\(`(WITH batch.+?)`, values.flat\(\)\)", SOURCE, re.S).group(1)
APPEND = re.sub(r"\$\{values\.map.+?\}", "(?,?,?,?,?,?,?,?,?,?)", APPEND)
READ = re.search(r"getAllAsync<ReceiptRow>\(`(.+?)`, \[userId, sessionId\]", SOURCE, re.S).group(1)
CLEANUP = re.findall(r'db.runAsync\("([^"]*(?:_removed|DELETE FROM recording_route_receipt)[^"]*)"', SOURCE)


class RecordingRouteReceiptSqlTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.executescript(SCHEMA)
        self.db.executescript(SCHEMA)

    def append(self, owner, session, stamp=10, speed=None):
        self.db.execute(APPEND, (owner, session, stamp, 35, 139, 3, speed, 0, 30000, 50))

    def read(self, owner, session):
        return self.db.execute(READ, (owner, session)).fetchall()

    def test_owner_and_session_are_separate_and_retry_preserves_first_receipt(self):
        self.append("a", "s", 15, 0.0)
        self.append("a", "s", 10)
        self.append("a", "s", 15, 9.0)
        self.append("a", "other", 12, 1.0)
        self.append("b", "s", 20, 2.0)
        self.assertEqual([(row[0], row[4]) for row in self.read("a", "s")], [(10, None), (15, 0.0)])
        self.assertEqual([row[0] for row in self.read("a", "other")], [12])
        self.assertEqual([row[0] for row in self.read("b", "s")], [20])

    def test_session_discard_and_owner_deletion_fence_late_delivery(self):
        for owner, session in [("a", "s"), ("a", "other"), ("b", "s")]:
            self.append(owner, session)
        self.db.execute(CLEANUP[0], ("a", "s"))
        self.append("a", "s", 11)
        self.assertEqual(self.read("a", "s"), [])
        self.db.execute(CLEANUP[1], ("a", "s"))
        self.db.execute(CLEANUP[2], ("a",))
        self.db.execute(CLEANUP[3], ("a",))
        self.append("a", "new")
        self.assertEqual(self.read("a", "other"), [])
        self.assertEqual(self.read("a", "new"), [])
        self.assertEqual(len(self.read("b", "s")), 1)


if __name__ == "__main__":
    unittest.main()
