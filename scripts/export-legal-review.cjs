const fs=require('node:fs'),ts=require('typescript');
function cleanJSX(value){
 const lines=value.split(/\r\n|\n|\r/);let last=0;
 lines.forEach((l,i)=>{if(/[^ \t]/.test(l))last=i;});
 return lines.map((l,i)=>{l=l.replace(/\t/g,' ');if(i!==0)l=l.replace(/^ +/,'');if(i!==lines.length-1)l=l.replace(/ +$/,'');return l+(l&&i!==last?' ':'');}).join('');
}
function read(file){
 const sf=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),99,true,4);
 if(sf.parseDiagnostics.length)throw Error('Syntax error: '+file);
 const sections=[];let intro='';let date='';
 function content(node){if(ts.isJsxText(node))return cleanJSX(node.text);if(ts.isJsxExpression(node)){return node.expression&&ts.isStringLiteral(node.expression)?node.expression.text:'';}return node.getChildren(sf).map(content).join('');}
 function visit(n){
 if(ts.isVariableDeclaration(n)&&n.name.getText(sf)==='LAST_UPDATED')date=n.initializer.text;
 if(ts.isJsxElement(n)){
 if(n.openingElement.tagName.getText(sf)==='Section'){
 const title=n.openingElement.attributes.properties.find(a=>a.name?.text==='title').initializer.text;
 sections.push({title,text:n.children.map(content).join('').trim()});
 }
 if(n.openingElement.tagName.getText(sf)==='Text'&&n.openingElement.attributes.getText(sf).includes('styles.intro}'))intro=n.children.map(content).join('').trim();
 }
 ts.forEachChild(n,visit);
 }visit(sf);return{intro,date,sections};
}
const result={};for(const name of ['PrivacyPolicyScreen','TermsOfServiceScreen'])result[name]={before:read(`docs/legal-previous/${name}.tsx.txt`),after:read(`src/screens/${name}.tsx`)};
if (require.main === module) fs.writeFileSync('docs/legal-v2-review-data.json',JSON.stringify(result,null,2));
module.exports = { read };
