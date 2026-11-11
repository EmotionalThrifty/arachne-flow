import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin } from './load.mjs'
const I=(await loadPlugin())._internals
function text(e){if(e==null)return '';if(Array.isArray(e))return e.map(text).join('');return typeof e==='object'?text(e.props?.children):String(e)}
function expand(e){if(e==null||typeof e!=='object')return e;if(Array.isArray(e))return e.map(expand);if(typeof e.type==='function')return expand(e.type(e.props||{}));return {type:e.type,props:{...e.props,children:expand(e.props?.children)}}}
function elements(e,out=[]){if(Array.isArray(e))e.forEach(x=>elements(x,out));else if(e&&typeof e==='object'){out.push(e);elements(e.props?.children,out)}return out}
globalThis.document=globalThis.document||{activeElement:null,body:{},addEventListener(){},removeEventListener(){}}
const node={id:'n1',type:'text.template',params:{template:'{{value}}'}}
const flow={nodes:[node],edges:[]}
test('recording switch is an explicit node property and preserves unrelated params',()=>{
 const changed=I.updateNode(flow,'n1',{record_inputs:true})
 assert.equal(changed.nodes[0].record_inputs,true)
 assert.deepEqual(changed.nodes[0].params,node.params)
 assert.equal(node.record_inputs,undefined)
})
test('inputs viewer uses historical input ports even on failed nodes',()=>{
 const run={id:'r1',nodes:{n1:{status:'error',outputs:{out:'different'},inputs:{value:0,_hidden:false}}}}
 const tree=expand(I.ValueViewer({api:null,run,flow,node,field:'inputs',port:'value',state:{status:'ready',kind:'json',text:'0'}}))
 const labels=elements(tree).filter(e=>e.props?.['data-fc-value-port']!==undefined).map(e=>e.props['data-fc-value-port'])
 assert.deepEqual(labels,['value','_hidden'])
 assert.match(text(tree),/inputs/i)
 assert.ok(text(tree).includes('0'))
 assert.ok(!labels.includes('out'))
})
test('legacy runs explicitly report unrecorded inputs rather than current params',()=>{
 const run={id:'r1',nodes:{n1:{status:'done',outputs:{out:'old'}}}}
 const tree=expand(I.ValueViewer({api:null,run,flow,node,field:'inputs',port:null}))
 assert.match(text(tree),/not recorded/i)
 assert.ok(!text(tree).includes('{{value}}'))
})
test('input loader forwards the inputs field to every page',async()=>{
 const calls=[];const version='b'.repeat(64)
 const api={async runValue(...args){calls.push(args);return calls.length===1?{kind:'text',chunk:'a',offset:0,next_offset:1,total_chars:2,version}:{kind:'text',chunk:'b',offset:1,next_offset:null,total_chars:2,version}}}
 const out=await I.loadRunValue(api,'r','n','p',{field:'inputs'})
 assert.equal(out.status,'ready')
 assert.equal(out.text,'ab')
 assert.ok(calls.every(args=>args[6]==='inputs'))
})
