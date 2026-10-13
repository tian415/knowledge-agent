import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the shipped renderer with a minimal DOM boundary; no HTML parser.
// Using innerHTML (and accidentally executing source HTML) fails immediately.
class Node {
 constructor(tag, text=''){this.tag=tag;this.children=[];this.text=text;}
 append(...children){this.children.push(...children.map(n=>typeof n==='string'?new Node('#text',n):n));}
 set textContent(text){this.text=text;this.children=[];}
 get textContent(){return this.text+this.children.map(n=>n.textContent).join('');}
 set innerHTML(_){throw Error('Source HTML must never be interpreted');}
}
const source=await fs.readFile(new URL('../../web/capture/runs.js',import.meta.url),'utf8');
function render(markdown){
 const document={createElement:tag=>new Node(tag),createTextNode:text=>new Node('#text',text)};
 const context=vm.createContext({document});
 vm.runInContext(source.slice(0,source.indexOf('async function refresh(){'))+'\nglobalThis.render=renderText;',context);
 const root=new Node('main');context.render(root,markdown);return root;
}
const find=(root,tag)=>[...(root.tag===tag?[root]:[]),...root.children.flatMap(n=>find(n,tag))];

test('reader shows emphasis and inline code without leaking Markdown delimiters',()=>{
 const root=render('# 决策\n\n保留 **用户要求** 与 `criteria`。\n\n- **建议**尚未确认');
 assert.deepEqual(find(root,'strong').map(n=>n.textContent),['用户要求','建议']);
 assert.deepEqual(find(root,'code').map(n=>n.textContent),['criteria']);
 assert.equal(find(root,'li')[0].textContent,'建议尚未确认');
});

test('untrusted HTML and code remain literal text, never executable elements',()=>{
 const root=render('**<img src=x onerror=alert(1)>**\n\n```html\n<script>alert(1)</script>\n**literal**\n```');
 assert.equal(find(root,'img').length,0);assert.equal(find(root,'script').length,0);
 assert.equal(find(root,'strong')[0].textContent,'<img src=x onerror=alert(1)>');
 assert.equal(find(root,'pre')[0].textContent,'<script>alert(1)</script>\n**literal**');
});
