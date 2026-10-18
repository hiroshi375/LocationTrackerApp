const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const fs = require('node:fs');
const vm = require('node:vm');
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/services/legalConsentPolicy.ts','utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS},
}).outputText, {exports: exportsObject});
const {evaluateLegalConsent, LEGAL_DOCUMENTS_V2_ENABLED} = exportsObject;
const required = {terms:'2026-10-19',privacy:'2026-10-19'};
const accepted = {termsAcceptedAt:'2026-10-01',privacyPolicyAcceptedAt:'2026-10-01',termsVersion:'2026-09-23',privacyPolicyVersion:'2026-09-23'};
test('approved revised documents require renewed consent',()=>assert.equal(LEGAL_DOCUMENTS_V2_ENABLED,true));
test('original document screens are active without duplicate v2 screens',()=>{
 const nav=fs.readFileSync('src/navigation/RootNavigator.tsx','utf8');
 for(const name of ['PrivacyPolicyScreen','TermsOfServiceScreen']) {
  assert.ok(nav.includes('../screens/'+name+'\"'));
  assert.equal(fs.existsSync('src/screens/'+name+'_v2.tsx'),false);
  assert.ok(fs.readFileSync('src/screens/'+name+'.tsx','utf8').includes('2026年10月19日'));
 }
});
test('previous consent requires renewal for revised documents',()=>{
 const s=evaluateLegalConsent(accepted,required,true);assert.equal(s.hasAccepted,false);assert.equal(s.requiresRenewal,true);
});
test('matching both document versions completes renewal',()=>assert.equal(evaluateLegalConsent({...accepted,termsVersion:required.terms,privacyPolicyVersion:required.privacy},required,true).hasAccepted,true));
test('either stale or missing version still requires renewal',()=>{
 for (const patch of [{termsVersion:null},{privacyPolicyVersion:null},{termsVersion:required.terms}]) assert.equal(evaluateLegalConsent({...accepted,...patch},required,true).requiresRenewal,true);
});
test('first acceptance needs both timestamps and is not labelled renewal',()=>{
 for(const record of [{},{...accepted,termsAcceptedAt:null},{...accepted,privacyPolicyAcceptedAt:null}]){
 const s=evaluateLegalConsent(record,required,true);assert.equal(s.hasAccepted,false);assert.equal(s.requiresRenewal,false);
 }
});
test('before approval legacy consent behavior is preserved',()=>assert.equal(evaluateLegalConsent(accepted,required,false).hasAccepted,true));
