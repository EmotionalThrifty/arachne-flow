import asyncio, json, os, shutil, unittest
import helpers
E=helpers.load_engine()

class InputHistoryTest(unittest.TestCase):
    def setUp(self):
        global E
        E=helpers.load_engine()
        self.root=helpers.temp_data_dir()
        self.addCleanup(shutil.rmtree,self.root,True)
        self.env=E.env.Env(ctx=helpers.FakeCtx({'sink':lambda args:json.dumps({'success':True})}),state={'tool_source':lambda:[{'name':'sink','read_only':True,'parameters':{'type':'object','properties':{'data':{'type':'object'}},'required':['data']}}]})
    def build(self,opt_in=False,loop=False,value=None):
        ops=[{'op':'add_node','ref':'source','type':'input.json','params':{'value':json.dumps(value if value is not None else {'ok':False,'count':0,'nested':{'api_key':'do-not-record'},'access_token':'secret-fixture'})}},
             {'op':'add_node','ref':'target','type':'tool:sink','record_inputs':opt_in}]
        if loop:
            ops=[{'op':'add_node','ref':'source','type':'input.json','params':{'value':'[{"x":1},{"x":2}]'}},
                 {'op':'add_node','ref':'each','type':'logic.foreach'},
                 {'op':'add_node','ref':'target','type':'tool:sink','record_inputs':opt_in},
                 {'op':'add_node','ref':'collect','type':'logic.collect'},
                 {'op':'connect','from':'source.value','to':'each.list'},
                 {'op':'connect','from':'each.item','to':'target.data'},
                 {'op':'connect','from':'target.result','to':'collect.value'}]
        else: ops += [{'op':'connect','from':'source.value','to':'target.data'}]
        flow,refs=E.graph.apply_ops(E.graph.new_flow('Input history fixture'),ops,E.nodes.types_by_name(self.env))
        flow=E.store.save_flow(self.env,flow,create=True)
        return flow,{entry['ref']:entry['node'] for entry in refs if entry.get('ref')}
    def run_flow(self,flow):
        result=E.runner.run_sync(self.env,flow['id'],timeout_s=5)
        self.assertEqual(result['status'],'done',result.get('error'))
        return result
    def test_input_recording_is_explicitly_off_by_default(self):
        flow,refs=self.build()
        state=self.run_flow(flow)['nodes'][refs['target']]
        self.assertNotIn('inputs',state)
    def test_recorded_inputs_are_actual_redacted_values_on_success_and_cache_hit(self):
        flow,refs=self.build(True)
        first=self.run_flow(flow)
        for result in (first,self.run_flow(flow)):
            state=result['nodes'][refs['target']]
            self.assertEqual(state.get('input_history',{}).get('status'),'recorded')
            self.assertEqual(state['inputs']['data']['ok'],False)
            self.assertEqual(state['inputs']['data']['count'],0)
            self.assertEqual(state['inputs']['data']['nested']['api_key'],'[redacted]')
            self.assertNotIn('secret-fixture',json.dumps(state['inputs']))
        self.assertEqual(result['nodes'][refs['target']]['status'],'cached')
        loaded=E.runner.get_run(self.env,first['id'])
        self.assertEqual(loaded['nodes'][refs['target']]['inputs'],first['nodes'][refs['target']]['inputs'])
    def test_loop_inputs_keep_real_item_indices_and_values(self):
        flow,refs=self.build(True,loop=True)
        result=self.run_flow(flow)
        inputs=result['nodes'][refs['target']].get('inputs',{})
        self.assertEqual(inputs,{'item 1':{'data':{'x':1}},'item 2':{'data':{'x':2}}})
        self.assertEqual(list(inputs),['item 1','item 2'])
    def test_recording_option_is_strict_boolean_and_editable(self):
        with self.assertRaisesRegex(ValueError,'record_inputs'):
            self.build('false')
        flow,refs=self.build(False)
        changed,_=E.graph.apply_ops(flow,[{'op':'update_node','node':refs['target'],'record_inputs':True}],E.nodes.types_by_name(self.env))
        self.assertIs(E.graph.node_by_id(changed,refs['target']).get('record_inputs'),True)
    def test_value_api_reads_recorded_inputs_not_current_flow_settings(self):
        flow,refs=self.build(True,value={'text':'A'*70000})
        result=self.run_flow(flow)
        query={'node':refs['target'],'field':'inputs','port':'data','offset':0,'limit':65536,'consistent':1}
        first=asyncio.run(E.api.handle('GET',f"runs/{result['id']}/value",query,{},self.env))
        chunks=[first['chunk']];offset=first['next_offset']
        while offset is not None:
            page=asyncio.run(E.api.handle('GET',f"runs/{result['id']}/value",{**query,'offset':offset,'version':first['version']},{},self.env))
            chunks.append(page['chunk']);offset=page['next_offset']
        self.assertEqual(json.loads(''.join(chunks)),{'text':'A'*70000})
        with self.assertRaises(Exception):
            asyncio.run(E.api.handle('GET',f"runs/{result['id']}/value",{**query,'field':'params'},{},self.env))

    def test_error_keeps_inputs_and_never_synthesizes_unrun_inputs(self):
        self.env.ctx=helpers.FakeCtx({'sink':lambda args:json.dumps({'success':False,'error':'synthetic failure'})})
        flow,refs=self.build(True)
        result=E.runner.run_sync(self.env,flow['id'],timeout_s=5)
        self.assertEqual(result['status'],'error')
        self.assertEqual(result['nodes'][refs['target']]['input_history']['status'],'recorded')
        self.assertEqual(result['nodes'][refs['target']]['inputs']['data']['count'],0)
    def test_history_byte_limit_omits_snapshot_without_failing_execution(self):
        from unittest.mock import patch
        from flowcanvas_engine import input_history as H
        flow,refs=self.build(True,value={'text':'x'*500})
        with patch.object(H,'MAX_BYTES',64):
            result=self.run_flow(flow)
        state=result['nodes'][refs['target']]
        self.assertEqual(state['input_history']['status'],'omitted')
        self.assertNotIn('inputs',state)
    def test_versions_are_scoped_to_input_or_output_even_for_identical_text(self):
        from fastapi import HTTPException
        flow,refs=self.build(True)
        run=self.run_flow(flow);nid=refs['target']
        run['nodes'][nid].update(inputs={'shared':'same'},outputs={'shared':'same'})
        E.store.save_run(self.env,run)
        query={'node':nid,'port':'shared','consistent':1}
        first=asyncio.run(E.api.handle('GET',f"runs/{run['id']}/value",query,{},self.env))
        with self.assertRaises(HTTPException) as error:
            asyncio.run(E.api.handle('GET',f"runs/{run['id']}/value",{**query,'field':'inputs','version':first['version']},{},self.env))
        self.assertEqual(error.exception.status_code,409)
