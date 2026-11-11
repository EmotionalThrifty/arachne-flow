import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './load.mjs'
const I=(await loadPlugin())._internals
function render(e) {
  if(e==null||typeof e!=='object')return e
  if(Array.isArray(e))return e.map(render)
  if(typeof e.type==='function')return render(e.type(e.props||{}))
  return {type:e.type,props:{...e.props,children:render(e.props?.children)}}
}
function elements(e,out=[]) {
  if(Array.isArray(e))e.forEach(x=>elements(x,out))
  else if(e&&typeof e==='object'){out.push(e);elements(e.props?.children,out)}
  return out
}
function text(e){if(e==null)return '';if(Array.isArray(e))return e.map(text).join('');return typeof e==='object'?text(e.props?.children):String(e)}

test('JSON formatter preserves exact number lexemes and quoted delimiters',()=>{
  const raw='{"id":9007199254740993,"decimal":1.000000000000000000001,"s":"{\\\"x\\\": [a,b]}","n":1e-7}'
  const formatted=I.formatJsonText(raw)
  assert.ok(formatted.includes('9007199254740993'))
  assert.ok(formatted.includes('1.000000000000000000001'))
  assert.ok(formatted.includes('1e-7'))
  assert.deepEqual(JSON.parse(formatted),JSON.parse(raw))
  for(const scalar of ['null','false','0','"雪"','[]','{}'])assert.deepEqual(JSON.parse(I.formatJsonText(scalar)),JSON.parse(scalar))
})
test('JSON formatter rejects invalid, oversized, nonfinite and deep inputs',()=>{
  for(const raw of ['{','NaN','1e999','['.repeat(40)+'0'+']'.repeat(40),'"'+'x'.repeat(1048576)+'"'])assert.throws(()=>I.formatJsonText(raw))
})
test('JSON editor formats without converting the stored value into a rounded object',()=>{
  let saved
  const tree=render(I.JsonInputEditor({value:'{"id":9007199254740993}',onChange:v=>{saved=v}}))
  const els=elements(tree)
  const button=els.find(e=>e.type==='button'&&text(e)==='Format JSON')
  assert.ok(button)
  button.props.onClick()
  assert.equal(typeof saved,'string')
  assert.ok(saved.includes('9007199254740993'))
  assert.ok(els.some(e=>e.type==='textarea'))
})
test('Markdown renders headings, lists and code as inert React nodes',()=>{
  const tree=render(I.SafeMarkdown({text:'# 雪\n\n- first\n- second\n\n```html\n<img src=x onerror=alert(1)>\n```'}))
  const els=elements(tree)
  assert.ok(els.some(e=>e.type==='h1'))
  assert.ok(els.some(e=>e.type==='ul'))
  assert.ok(els.some(e=>e.type==='code'))
  assert.ok(text(tree).includes('<img src=x onerror=alert(1)>'))
  assert.ok(els.every(e=>!e.props?.dangerouslySetInnerHTML))
})
test('Markdown never fetches images or activates HTML and javascript/data links',()=>{
  const tree=render(I.SafeMarkdown({text:'<script>alert(1)</script>\n![remote](https://evil.test/pixel) [bad](javascript:alert) [data](data:text/html,boom) [safe](https://example.test/ok)'}))
  const els=elements(tree)
  assert.ok(els.every(e=>!['img','script','iframe','object','embed','link','style'].includes(e.type)))
  const links=els.filter(e=>e.type==='a')
  assert.deepEqual(links.map(e=>e.props.href),['https://example.test/ok'])
  assert.ok(links.every(e=>e.props.rel.includes('noopener')))
  assert.ok(text(tree).includes('<script>'))
})
test('Build object exposes typed dynamic inputs in the canvas',()=>{
  const ports=I.nodePorts({params:{fields:'{{url}} {{count}}'}},{inputs:[],outputs:[],dynamic_inputs:'fields',dynamic_input_type:'any'})
  assert.deepEqual(ports.inputs.map(p=>[p.name,p.type]),[['url','any'],['count','any']])
})

test('SafeMarkdown warns when truncated across CR, LF, and CRLF line endings',()=>{
  const makeText=(sep,lines)=>Array(lines).fill('a').join(sep)
  const warnText='Preview truncated'

  const cr5000=render(I.SafeMarkdown({text:makeText('\r',5000)}))
  assert.ok(!text(cr5000).includes(warnText))

  const cr5001=render(I.SafeMarkdown({text:makeText('\r',5001)}))
  assert.ok(text(cr5001).includes(warnText))

  const lf5001=render(I.SafeMarkdown({text:makeText('\n',5001)}))
  assert.ok(text(lf5001).includes(warnText))

  const crlf5001=render(I.SafeMarkdown({text:makeText('\r\n',5001)}))
  assert.ok(text(crlf5001).includes(warnText))
})
