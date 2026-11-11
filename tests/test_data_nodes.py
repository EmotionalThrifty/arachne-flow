"""Offline contract for JSON inputs and deterministic data transforms."""
import asyncio
import json
import tempfile
import unittest
import helpers

E=helpers.load_engine()

class DataNodesTest(unittest.TestCase):
    def setUp(self):
        global E
        E=helpers.load_engine()
        self.env=E.env.Env(ctx=helpers.FakeCtx(),state={})
        self.tmp=tempfile.TemporaryDirectory(prefix='fc-data-nodes-')
        self.addCleanup(self.tmp.cleanup)
        self.nctx=E.executors.NodeContext('r_test','n_test',self.tmp.name,log=lambda message:None)
    def execute(self,kind,params=None,inputs=None):
        return asyncio.run(E.executors.execute(self.env,{'type':kind,'params':params or {}},E.nodes.get_type(self.env,kind),inputs or {},self.nctx))
    def test_json_input_scalars_and_unicode(self):
        for value in (None,False,0,'a "quote" 😀',[1,False,None],{'x':'雪'}):
            with self.subTest(value=value):
                self.assertEqual(self.execute('input.json',{'value':json.dumps(value,ensure_ascii=False)}),{'value':value})
    def test_invalid_json_is_positioned_and_nonfinite_is_refused(self):
        with self.assertRaisesRegex(E.executors.NodeError,r'line 1.*column'):
            self.execute('input.json',{'value':'{"a":}'})
        for value in ('NaN','Infinity','1e999'):
            with self.subTest(value=value),self.assertRaises(E.executors.NodeError):
                self.execute('input.json',{'value':value})
    def test_json_limits_and_reserved_keys(self):
        for text in ('['*40+'0'+']'*40, '"'+'a'*1048576+'"'):
            with self.assertRaises(E.executors.NodeError):
                self.execute('input.json',{'value':text})
        result=self.execute('input.json',{'value':'{"$large":{"path":"private"},"nested":{"$media":{}}}'})['value']
        self.assertNotIn('$large',result)
        self.assertIn('_$large',result)
        self.assertNotIn('$media',result['nested'])
    def test_json_input_is_a_run_override_and_template_reset(self):
        flow={'nodes':[{'id':'n_json','type':'input.json','title':'Payload','params':{'value':'{}'}}],'edges':[]}
        effective=E.runner.apply_inputs(flow,{'Payload':'null'})
        self.assertEqual(effective['nodes'][0]['params']['value'],'null')
        self.assertEqual(flow['nodes'][0]['params']['value'],'{}')
        self.assertIn('input.json',E.store.INPUT_RESETS)
    def test_json_build_uses_values_without_text_interpolation(self):
        supplied={'url':'https://example.test/"quoted"','count':0,'ok':False,'meta':{'a':[1]}}
        out=self.execute('json.build',{'fields':'{{url}} {{count}} {{ok}} {{meta}}'},supplied)
        self.assertEqual(out,{'value':supplied})
        ports=E.graph.node_ports({'type':'json.build','params':{'fields':'{{url}} {{count}}'}},E.nodes.types_by_name(self.env))[0]
        self.assertEqual([p['name'] for p in ports],['url','count'])
        self.assertTrue(all(p['type']=='any' for p in ports))
    def test_set_field_does_not_mutate_upstream(self):
        original={'before':{'x':1}}
        out=self.execute('json.set',{'key':'url'},{'data':original,'value':'x"y'})
        self.assertEqual(out['value']['url'],'x"y')
        self.assertNotIn('url',original)
    def test_split_join_empty_unicode_and_literal_separator(self):
        self.assertEqual(self.execute('text.split',{'separator':'|'},{'text':'雪||😀|'})['list'],['雪','','😀',''])
        self.assertEqual(self.execute('text.split',{'separator':'|','keep_empty':False},{'text':'a||b|'})['list'],['a','b'])
        self.assertEqual(self.execute('text.join',{'separator':'|'},{'list':['雪','','😀']})['text'],'雪||😀')
        with self.assertRaises(E.executors.NodeError):
            self.execute('text.split',{'separator':''},{'text':'a'})
    def test_deduplicate_retains_order_and_types(self):
        values=[False,0,1,True,{'a':1,'b':2},{'b':2,'a':1},[1],[1],None,None]
        self.assertEqual(self.execute('list.deduplicate',inputs={'list':values})['list'],[False,0,1,True,{'a':1,'b':2},[1],None])
    def test_filter_not_empty_keeps_false_and_zero(self):
        self.assertEqual(self.execute('list.filter',{'op':'not empty'},{'list':[None,'',[],{},False,0,'雪']})['list'],[False,0,'雪'])
    def test_wrong_collection_input_is_a_controlled_error(self):
        for kind in ('text.join','list.filter','list.deduplicate'):
            with self.subTest(kind=kind),self.assertRaises(E.executors.NodeError):
                self.execute(kind,inputs={'list':{'not':'a list'}})

    def test_join_checks_separator_amplification_before_allocation(self):
        class GuardSeparator(str):
            def join(self, items):
                raise AssertionError('oversized join reached allocation before the size check')
        with self.assertRaisesRegex(E.executors.NodeError, 'exceeds'):
            self.execute('text.join', {'separator':GuardSeparator('x'*1024)}, {'list':[None]*2048})
