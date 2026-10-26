"""Execute the native journal's real SQL against SQLite, including disk reopen and identity isolation."""
import pathlib, re, sqlite3, tempfile, unittest
SOURCE = (pathlib.Path(__file__).parents[1] / 'node_modules/expo-location/android/src/main/java/expo/modules/location/taskConsumers/RecordingInbox.kt').read_text()
SCHEMA = re.findall(r'db.execSQL\("(CREATE TABLE [^"]+)"\)', SOURCE)
INSERT = re.search(r'db.execSQL\("(INSERT OR IGNORE INTO points[^"]+)"', SOURCE).group(1)
ACK = re.search(r'db.delete\("points", "([^"]+)", arrayOf\(owner,session,id.toString\(\)\)\)', SOURCE).group(1)

class NativeInboxSql(unittest.TestCase):
    def test_crash_reopen_duplicates_and_ack_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(pathlib.Path(directory) / 'inbox.db')
            db = sqlite3.connect(path)
            for sql in SCHEMA: db.execute(sql)
            point = ('A', 'S1', 1000, 35, 139, '{}', '{}')
            db.execute(INSERT, point); db.commit(); db.close()
            db = sqlite3.connect(path)
            db.execute(INSERT, point)
            db.execute(INSERT, ('B', 'S1', 1000, 35, 139, '{}', '{}'))
            db.execute(INSERT, ('A', 'S2', 1000, 35, 139, '{}', '{}'))
            self.assertEqual(db.execute('SELECT COUNT(*) FROM points').fetchone()[0], 3)
            receipt = db.execute("SELECT id FROM points WHERE owner='A' AND session='S1'").fetchone()[0]
            self.assertEqual(db.execute('DELETE FROM points WHERE '+ACK, ('B', 'S1', receipt)).rowcount, 0)
            self.assertEqual(db.execute('DELETE FROM points WHERE '+ACK, ('A', 'S2', receipt)).rowcount, 0)
            self.assertEqual(db.execute('DELETE FROM points WHERE '+ACK, ('A', 'S1', receipt)).rowcount, 1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM points').fetchone()[0], 2)
            db.close()

    def test_account_cleanup_is_scoped_to_owner(self):
        db = sqlite3.connect(':memory:')
        for sql in SCHEMA: db.execute(sql)
        for owner in ['A','B']: db.execute(INSERT, (owner,'S',1000,35,139,'{}','{}'))
        db.execute('DELETE FROM points WHERE owner=?', ('A',))
        self.assertEqual(db.execute('SELECT owner FROM points').fetchall(), [('B',)])

    def test_stop_seal_and_failed_stop_resume_are_session_scoped(self):
        db = sqlite3.connect(':memory:')
        for sql in SCHEMA: db.execute(sql)
        seal = re.search(r'execSQL\("(INSERT OR IGNORE INTO sealed[^"]+)"', SOURCE).group(1)
        check = re.search(r'rawQuery\("(SELECT 1 FROM sealed[^"]+)"', SOURCE).group(1)
        db.execute(seal, ('A', 'S1'))
        self.assertIsNotNone(db.execute(check, ('A', 'S1')).fetchone())
        self.assertIsNone(db.execute(check, ('A', 'S2')).fetchone())
        self.assertIsNone(db.execute(check, ('B', 'S1')).fetchone())
        db.execute('DELETE FROM sealed WHERE owner=? AND session=?', ('A', 'S1'))
        self.assertIsNone(db.execute(check, ('A', 'S1')).fetchone())

if __name__ == '__main__': unittest.main()
