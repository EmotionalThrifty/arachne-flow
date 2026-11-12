import asyncio, math, unittest, json
import helpers
E=helpers.load_engine()

class ReviewEdges(unittest.TestCase):
    def setUp(self):
        global E
        E=helpers.load_engine()
        self.env=E.env.Env(ctx=helpers.FakeCtx(),state={})
        self.tmp=helpers.temp_data_dir()
        self.nctx=E.executors.NodeContext('r_edge','n_edge',self.tmp,log=lambda m:None)
    def run_node(self,kind,params=None,inputs=None):
        return asyncio.run(E.executors.execute(self.env,{'type':kind,'params':params or {}},E.nodes.get_type(self.env,kind),inputs or {},self.nctx))
    def test_split_exactly_max_items_is_not_rejected(self):
        text='|'.join(['x']*50000)
        result=self.run_node('text.split',{'separator':'|'},{'text':text})
        self.assertEqual(len(result['list']),50000)
    def test_split_overflow_is_rejected_without_massive_intermediate(self):
        text='|'.join(['x']*50001)
        with self.assertRaises(E.executors.NodeError):self.run_node('text.split',{'separator':'|'},{'text':text})
    def test_json_set_defangs_nested_engine_markers(self):
        result=self.run_node('json.set',{'key':'payload'},{'data':{},'value':{'$large':{'path':'private'},'nested':[{'$media':{}}]}})
        self.assertNotIn('$large',result['value']['payload'])
        self.assertNotIn('$media',result['value']['payload']['nested'][0])
    def test_history_rejects_nonfinite_numbers_without_failing_run(self):
        from arachne_flow_engine import input_history as H
        with self.assertRaises(ValueError):
            H.snapshot({'x':float('nan')})
        with self.assertRaises(ValueError):
            H.snapshot({'x':float('inf')})
    def test_history_handles_tuple_input_and_redacts_nested_sensitive_values(self):
        from arachne_flow_engine import input_history as H
        result,size=H.snapshot({'items':(1,2,False,None,{'api_key':'x'})})
        self.assertEqual(result['items'],[1,2,False,None,{'api_key':'[redacted]'}])
        self.assertGreater(size,0)
    def test_loop_history_survives_unrelated_key_and_concurrent_updates(self):
        class H:
            def __init__(self):self.run={'id':'r','flow_id':'f','nodes':{'n':{'inputs':{'existing':{'x':1}}}},'_input_history_sizes':{}};self.lock=__import__('threading').RLock();self.cancel=__import__('threading').Event();self.env=None;self.handle=self;self._input_history_incomplete=set();self.saved=[]
            def set_node(self,nid,**fields):self.run['nodes'].setdefault(nid,{}).update(fields);self.saved.append(fields)
            def snapshot(self):return self.run
        # Build only the method's dependencies, without a real run.
        from arachne_flow_engine.runner import _Execution
        h=H();h._input_history_sizes={};h._input_history_incomplete=set();h.nodes={'n':{'record_inputs':True}}
        import arachne_flow_engine.runner as R
        ex=object.__new__(_Execution);ex.handle=h;ex.run=h.run;ex.nodes=h.nodes;ex.env=self.env;ex._input_history_sizes={};ex._input_history_incomplete=set();ex._last_save=float('inf')
        ex.record_inputs('n',{'value':1}, {'inputs':[]}, index=1)
        self.assertIn('existing',ex.run['nodes']['n']['inputs'])
        self.assertIn('item 2',ex.run['nodes']['n']['inputs'])
