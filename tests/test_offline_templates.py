import json, os, shutil, unittest
from pathlib import Path
import helpers

class OfflineTemplateTest(unittest.TestCase):
    def setUp(self):
        self.E=helpers.load_engine()
        self.root=helpers.temp_data_dir();self.addCleanup(shutil.rmtree,self.root,True)
        self.env=self.E.env.Env(ctx=helpers.FakeCtx(),state={'tool_source':lambda:[]})
    def check_template(self,name,expected):
        path=Path(__file__).resolve().parent.parent/'templates'/name
        template=json.loads(path.read_text(encoding='utf-8'))
        self.assertTrue(all(n['type']!='llm.complete' and not n['type'].startswith(('tool:','preset.')) for n in template['nodes']))
        flow=self.E.graph.new_flow(template['name']);flow.update(nodes=template['nodes'],edges=template['edges'])
        self.assertFalse(self.E.graph.has_errors(self.E.graph.validate(flow,self.E.nodes.types_by_name(self.env))))
        saved=self.E.store.save_flow(self.env,flow,create=True)
        run=self.E.runner.run_sync(self.env,saved['id'],timeout_s=5)
        self.assertEqual(run['status'],'done',run.get('error'))
        node=next(n for n in saved['nodes'] if n['type']=='output.preview')
        self.assertEqual(self.E.runner.load_value(run['nodes'][node['id']]['outputs']['value']),expected)
    def test_local_list_cleanup(self):
        self.check_template('local-list-cleanup.json','alpha | 雪 | false | 0')
    def test_typed_json_loop_collect(self):
        self.check_template('json-loop-collect.json',[{'title':'One','url':'https://example.test/1'},{'title':'Two','url':'https://example.test/2'}])
