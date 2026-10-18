const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { read } = require('../scripts/export-legal-review.cjs');
const escape = value => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
for(const [name,dir,count] of [['PrivacyPolicyScreen','privacy',13],['TermsOfServiceScreen','terms',16]]) {
 test(`${dir} web document includes every original app section without omissions`,()=>{
  const doc=read(`src/screens/${name}.tsx`);const html=fs.readFileSync(`docs/${dir}/index.html`,'utf8');
  assert.equal(doc.sections.length,count);assert.equal((html.match(/<section>/g)||[]).length,count);
  assert.ok(html.includes(escape(doc.intro)));assert.ok(html.includes(escape(doc.date)));
  for(const section of doc.sections)assert.ok(html.includes(`<h2>${escape(section.title)}</h2><p>${escape(section.text)}</p>`),section.title);
 });
}
test('unpublished 1.0.3 release is recorded without advertising it as publicly available',()=>{
 const v=JSON.parse(fs.readFileSync('docs/app-version.json','utf8'));
 for(const [platform,build,min] of [['android',24,19],['ios',9,3]]){
  assert.equal(v[platform].pendingRelease.version,'1.0.3');assert.equal(v[platform].pendingRelease.build,build);
  assert.ok(v[platform].latestBuild<build);assert.equal(v[platform].minimumSupportedBuild,min);
 }
});
