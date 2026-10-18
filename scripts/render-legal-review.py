# -*- coding: utf-8 -*-
"""Render the AST-extracted complete legal documents, without third-party packages."""
import json,html,difflib
from pathlib import Path
obj=json.loads(Path('docs/legal-v2-review-data.json').read_text())
md=['# AcLog Fit 改訂文書全文（ソース反映済み・配布前）','比較対象：現行文書と修正済みv2。アクティビティカレンダーの本人限定表示と機能名を実装に合わせて訂正済み。新版Androidの削除実機検証も完了しました。改定版は2026年10月19日。文書と再同意設定をソースへ同時反映しました。']
h=['<!doctype html><html lang="ja"><meta charset="utf-8"><title>AcLog Fit 文書全文レビュー</title><style>body{font-family:system-ui;max-width:1500px;margin:30px auto;padding:20px;line-height:1.8;color:#173344}table{width:100%;table-layout:fixed;border-collapse:collapse}td,th{width:50%;vertical-align:top;border:1px solid #cbd5df;padding:18px;white-space:pre-wrap;overflow-wrap:anywhere}ins{background:#d7f7df;text-decoration:none}del{background:#ffe0df}h2{margin-top:60px}.notice{background:#fff1cc;padding:15px}</style><h1>AcLog Fit 文書全文レビュー</h1><p class="notice">承認済み改訂文書（ソース反映済み・配布前）。左：現行全文／右：修正済みv2全文。緑＝追加、赤取消線＝削除。省略なし。アクティビティカレンダーの本人限定表示と機能名を実装に合わせて訂正済み。新版Androidの削除実機検証も完了しました。</p>']
def diff(a,b):
 left=[];right=[]
 for op,i,j,k,l in difflib.SequenceMatcher(None,a,b,autojunk=False).get_opcodes():
  aa=html.escape(a[i:j]);bb=html.escape(b[k:l]);left.append(aa if op=='equal' else '<del>'+aa+'</del>');right.append(bb if op=='equal' else '<ins>'+bb+'</ins>')
 return ''.join(left),''.join(right)
for name,docs in obj.items():
 title='プライバシーポリシー' if name.startswith('Privacy') else '利用規約'
 md+=['\n# '+title,docs['after']['intro'],'最終改定日（案）：'+docs['after']['date']]
 h+=['<h2>'+title+'</h2><table><tr><th>現行全文</th><th>修正済みv2全文</th></tr>']
 pairs=[('冒頭',docs['before']['intro'],docs['after']['intro']),('最終改定日',docs['before']['date'],docs['after']['date'])]
 pairs += [(b['title'],a['text'],b['text']) for a,b in zip(docs['before']['sections'],docs['after']['sections'])]
 for index,(title,a,b) in enumerate(pairs):
  aa,bb=diff(a,b);h+=['<tr><td><b>'+html.escape(title)+'</b><br>'+aa+'</td><td><b>'+html.escape(title)+'</b><br>'+bb+'</td></tr>']
  if index>=2:md+=['\n## '+title+(' 【変更】' if a!=b else ' 【変更なし】'),b]
 h+=['</table>']
Path('docs/legal-v2-full-review.md').write_text('\n\n'.join(md)+'\n')
Path('docs/legal-v2-full-comparison.html').write_text(''.join(h)+'</html>')
