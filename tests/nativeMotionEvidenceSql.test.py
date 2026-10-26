import re,sqlite3,unittest
from pathlib import Path
source=Path('node_modules/expo-location/android/src/main/java/expo/modules/location/taskConsumers/RecordingInbox.kt').read_text()
create=re.search(r'db.execSQL\("(CREATE TABLE IF NOT EXISTS motion_evidence[^"]+)"',source).group(1)
class LegacyDiagnosticCompatibility(unittest.TestCase):
 def make_db(self):
  db=sqlite3.connect(':memory:')
  for sql in re.findall(r'db.execSQL\("(CREATE TABLE (?!IF)[^"]+)"',source):db.execute(sql)
  return db
 def test_upgrade_preserves_unacknowledged_receipts_and_seals(self):
  db=self.make_db();db.execute("INSERT INTO points(owner,session,stamp,lat,lon,context,payload) VALUES('A','s',1,35,139,'{}','{\"aclogQualityEvidence\":\"old\"}')")
  db.execute("INSERT INTO sealed VALUES('A','s')");db.execute(create)
  self.assertEqual(db.execute('SELECT payload FROM points').fetchone()[0],'{"aclogQualityEvidence":"old"}')
  self.assertEqual(db.execute('SELECT COUNT(*) FROM sealed').fetchone()[0],1)
 def test_v2_legacy_table_kept_without_new_diagnostic_writes_or_database_reset(self):
  db=self.make_db();db.execute(create);db.execute("INSERT INTO motion_evidence VALUES('A','s',1,'{}')");db.execute(create)
  self.assertEqual(db.execute('SELECT COUNT(*) FROM motion_evidence').fetchone()[0],1)
  self.assertIn('null, 2)',source);self.assertNotIn('DROP TABLE',source);self.assertNotIn('INSERT OR IGNORE INTO motion_evidence',source)
 def test_discard_purges_only_legacy_target_and_retains_other_owners_receipts(self):
  db=self.make_db();db.execute(create)
  for owner,session in [('A','s'),('B','s'),('A','other')]:db.execute('INSERT INTO motion_evidence VALUES(?,?,1,?)',(owner,session,'{}'))
  block=source.split('fun discardMotion',1)[1].split('@Synchronized fun read',1)[0]
  self.assertIn('seal(owner,session,true)',block);self.assertIn('"owner=? AND session=?"',block)
  db.execute('INSERT OR IGNORE INTO sealed VALUES(?,?)',('A','s'));db.execute('DELETE FROM motion_evidence WHERE owner=? AND session=?',('A','s'))
  self.assertEqual(db.execute('SELECT owner,session FROM motion_evidence ORDER BY owner').fetchall(),[('A','other'),('B','s')])
 def test_account_delete_removes_legacy_diagnostics_without_cross_owner_deletion(self):
  db=self.make_db();db.execute(create)
  for owner in ['A','B']:
   db.execute('INSERT INTO points(owner,session,stamp,lat,lon,context,payload) VALUES(?,?,1,35,139,?,?)',(owner,'s','{}','{}'))
   db.execute('INSERT INTO sealed VALUES(?,?)',(owner,'s'));db.execute('INSERT INTO motion_evidence VALUES(?,?,1,?)',(owner,'s','{}'))
  block=source.split('fun deleteOwner',1)[1].split('companion object',1)[0]
  deletes=re.findall(r'db.delete\("([^"]+)",\s*"owner=\?",',block);self.assertEqual(set(deletes),{'points','sealed','motion_evidence'})
  for table in deletes:db.execute('DELETE FROM '+table+' WHERE owner=?',('A',))
  for table in deletes:self.assertEqual(db.execute('SELECT owner FROM '+table).fetchall(),[('B',)])
if __name__=='__main__':unittest.main()
