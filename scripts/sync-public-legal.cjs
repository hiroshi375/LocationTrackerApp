const fs = require('node:fs');
const path = require('node:path');
const { read } = require('./export-legal-review.cjs');
const escape = value => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const style = `body{margin:0;background:#fff;color:#253746;font-family:system-ui,-apple-system,sans-serif;line-height:1.85}main{max-width:850px;margin:auto;padding:24px 20px 64px}h1{font-size:1.7rem}h2{font-size:1.15rem;margin-top:32px}p{white-space:pre-line;overflow-wrap:anywhere}nav{display:flex;gap:20px;flex-wrap:wrap}a{color:#126491}footer{margin-top:40px;border-top:1px solid #ddd;padding-top:16px}`;
const nav = '<nav aria-label="関連ページ"><a href="../privacy/">プライバシーポリシー</a><a href="../terms/">利用規約</a><a href="../account-deletion/">アカウントとデータの削除</a><a href="../support/">お問い合わせ</a></nav>';
function render(title, doc) {
 return `<!DOCTYPE html>\n<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} | AcLog Fit</title><style>${style}</style></head><body><main><h1>${title}</h1><p class="intro">${escape(doc.intro)}</p>${doc.sections.map(s=>`<section><h2>${escape(s.title)}</h2><p>${escape(s.text)}</p></section>`).join('\n')}<footer><p>最終改定日：${escape(doc.date)}</p>${nav}</footer></main></body></html>\n`;
}
for (const [name, dir, title] of [['PrivacyPolicyScreen','privacy','プライバシーポリシー'],['TermsOfServiceScreen','terms','利用規約']]) {
 const target=path.join('docs',dir,'index.html'); fs.mkdirSync(path.dirname(target),{recursive:true});
 fs.writeFileSync(target,render(title,read(`src/screens/${name}.tsx`)));
}
// Account deletion instructions reuse the same deletion scope and exceptions as the app.
const policy=read('src/screens/PrivacyPolicyScreen.tsx');
const deletion=policy.sections.find(s=>s.title.startsWith('9.'));
fs.writeFileSync('docs/account-deletion/index.html',render('アカウントとデータの削除',{
 date:policy.date,
 intro:'AcLog Fitのアカウントと関連データを削除する方法をご案内します。',
 sections:[
 {title:'1. アプリ内からの削除',text:'「プロフィール」画面の「アカウントを削除」を選択し、確認画面で「削除する」「完全に削除」を選択してください。通信断やアプリ終了で中断した場合は、通信を確認してアプリを開き、「アカウント削除を再開」から再開してください。削除したデータは元に戻せません。'},
 {title:'2. アプリを利用できない場合',text:'アプリをアンインストール済みの場合など、アプリを利用できない場合は、登録したメールアドレスから hi64sa10@yahoo.co.jp へ、件名を「AcLog Fit アカウント削除依頼」としてお問い合わせください。パスワードや認証コードは送らないでください。本人確認のうえ対応します。'},
 {title:'3. 保存期間・削除対象・例外',text:deletion.text}
 ]
}));
