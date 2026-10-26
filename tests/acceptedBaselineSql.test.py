import re, sqlite3, unittest
from pathlib import Path
source=Path('src/services/locationLocationQueueService.ts').read_text().split('export async function getLatestAcceptedLocationQueueRow(',1)[1].split('export async function markLocationQueueRowSent(',1)[0]
query=re.search(r'`(.*?)`',source,re.S).group(1).replace('${TABLE_NAME}','queue')
columns=[c.strip() for c in query.split('SELECT',1)[1].split('FROM',1)[0].split(',')]
class BaselineQueryTest(unittest.TestCase):
 def setUp(self):
  self.db=sqlite3.connect(':memory:');self.db.execute('CREATE TABLE queue ('+','.join(c+(' INTEGER' if c=='recorded_at_ms' else ' TEXT') for c in columns)+')')
  for owner,session,stamp,status in [('A','s',20000,'sent'),('A','s',120000,'sent'),('B','s',59000,'sent'),('A','other',59000,'sent'),('A','s',55000,'pending')]:
   self.db.execute('INSERT INTO queue(user_id,recording_session_id,recorded_at_ms,queue_status) VALUES(?,?,?,?)',(owner,session,stamp,status))
 def get(self,stamp):return self.db.execute(query,{'userId':'A','recordingSessionId':'s','atOrBeforeMs':stamp}).fetchone()
 def test_future_and_foreign_and_pending_do_not_hide_old_backlog(self):self.assertEqual(self.get(60000)[columns.index('recorded_at_ms')],20000)
 def test_no_prior_point_is_not_treated_as_duplicate(self):self.assertIsNone(self.get(10000))
if __name__=='__main__':unittest.main()
