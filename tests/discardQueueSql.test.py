"""Exercise the production SQL with real SQLite, without requiring a mobile runtime."""
import pathlib
import re
import sqlite3
import unittest
import tempfile

SOURCE = (pathlib.Path(__file__).parents[1] / 'src/services/locationLocationQueueService.ts').read_text()
TABLE = re.search(r'const TABLE_NAME = ["\']([^"\']+)', SOURCE).group(1)
SCHEMA = re.search(r'await db.execAsync\(`(.*?)`\)', SOURCE, re.S).group(1).replace('${TABLE_NAME}', TABLE)
INSERT = re.search(r'(INSERT OR IGNORE INTO \$\{TABLE_NAME\} \(.*?WHERE NOT EXISTS \(.*?\))\s*`', SOURCE, re.S).group(1).replace('${TABLE_NAME}', TABLE)
MARKER = re.search(r'`(INSERT OR IGNORE INTO discarded_recording_sessions.*?)`', SOURCE, re.S).group(1)
DELETE = re.search(r'`(DELETE FROM \$\{TABLE_NAME\} WHERE user_id = \$userId AND recording_session_id = \$sessionId)`', SOURCE).group(1).replace('${TABLE_NAME}', TABLE)

PENDING = re.search(r'`(SELECT recording_session_id AS recordingSessionId.*?)`', SOURCE, re.S).group(1)
COMPLETE = re.search(r'`(UPDATE discarded_recording_sessions SET completed_at.*?)`', SOURCE, re.S).group(1)

class DiscardQueueSqlTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.executescript(SCHEMA)
    def tearDown(self):
        self.db.close()
    def insert(self, user, session, log_id):
        values = {key: None for key in re.findall(r'\$(\w+)', INSERT)}
        values.update(locationLogId=log_id, locationUniqueKey=log_id, userId=user,
            recordingSessionId=session, source='background', recordedAt='2026-10-21T00:00:00Z',
            recordedAtMs=1792540800000, receivedAt='2026-10-21T00:00:01Z', latitude=35,
            longitude=139, createdAt='2026-10-21T00:00:01Z')
        return self.db.execute(INSERT, values).rowcount
    def test_discard_blocks_delayed_reinsertion_without_affecting_other_sessions_or_accounts(self):
        self.assertEqual(self.insert('A', 's1', 'before'), 1)
        params = dict(userId='A', sessionId='s1', now='2026-10-21T00:00:02Z')
        self.db.execute(MARKER, params)
        self.db.execute(DELETE, params)
        self.assertEqual(self.insert('A', 's1', 'delayed'), 0)
        self.assertEqual(self.insert('B', 's1', 'other-account'), 1)
        self.assertEqual(self.insert('A', 's2', 'other-session'), 1)
        self.assertEqual(self.db.execute(f'SELECT count(*) FROM {TABLE}').fetchone()[0], 2)
    def test_schema_upgrade_and_repeated_discard_are_idempotent(self):
        self.db.executescript(SCHEMA)
        params = dict(userId='A', sessionId='s1', now='2026-10-21T00:00:02Z')
        for _ in range(2):
            self.db.execute(MARKER, params)
            self.db.execute(DELETE, params)
        self.assertEqual(self.insert('A', 's1', 'late'), 0)
        self.assertEqual(self.db.execute('SELECT count(*) FROM discarded_recording_sessions').fetchone()[0], 1)

    def test_pending_discard_survives_reopen_and_completed_work_is_not_restored(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / 'queue.db'
            db = sqlite3.connect(file)
            db.executescript(SCHEMA)
            params = dict(userId='A', sessionId='s1', now='2026-10-21T00:00:02Z')
            db.execute(MARKER, params)
            db.commit()
            db.close()
            db = sqlite3.connect(file)
            self.assertEqual(db.execute(PENDING, dict(userId='A')).fetchall(), [('s1',)])
            self.assertEqual(db.execute(PENDING, dict(userId='B')).fetchall(), [])
            db.execute(COMPLETE, params)
            db.commit()
            db.close()
            db = sqlite3.connect(file)
            self.assertEqual(db.execute(PENDING, dict(userId='A')).fetchall(), [])
            self.assertEqual(db.execute('SELECT count(*) FROM discarded_recording_sessions').fetchone()[0], 1)
            db.close()

if __name__ == '__main__':
    unittest.main()
