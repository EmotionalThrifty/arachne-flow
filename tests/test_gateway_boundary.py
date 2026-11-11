"""Offline proof that this package does not introduce a messaging bypass."""
import asyncio
import unittest
import helpers

class GatewayBoundaryTest(unittest.TestCase):
    def test_even_a_synthetic_registered_sender_is_blocked_by_default(self):
        engine=helpers.load_engine()
        calls=[]
        tool={'name':'send_message','toolset':'messaging','parameters':{'type':'object','properties':{'target':{'type':'string'},'message':{'type':'string'}}}}
        env=engine.env.Env(ctx=helpers.FakeCtx({'send_message':lambda args:calls.append(args)}),state={'tool_source':lambda:[tool]})
        spec=engine.nodes.get_type(env,'tool:send_message')
        self.assertIsNone(spec)
        ctx=engine.executors.NodeContext('r_fake','n_fake','unused',log=lambda message:None)
        with self.assertRaises(engine.executors.NodeError):
            asyncio.run(engine.executors.execute(env,{'type':'tool:send_message','params':{'target':'synthetic:never','message':'not sent'}},spec,{},ctx))
        self.assertEqual(calls,[])
    def test_custom_blocked_list_does_not_implicitly_unblock_raw_message_sender(self):
        engine=helpers.load_engine()
        class ConfigCtx(helpers.FakeCtx):
            def get_config(self,key,default=None):
                return {'blocked_tools':[]}.get(key,default)
        tools=[{'name':'mcp__messaging__channels_list','parameters':{'type':'object','properties':{}}},
               {'name':'mcp__messaging__messages_send','parameters':{'type':'object','properties':{}}}]
        env=engine.env.Env(ctx=ConfigCtx(),state={'tool_source':lambda:tools})
        names={t['type'] for t in engine.nodes.list_node_types(env,fresh=True)}
        self.assertNotIn('tool:mcp__messaging__messages_send',names)
        self.assertIn('output.send_message',names)
        blocked,allowed=engine.nodes.tool_policy(env)
        self.assertTrue(engine.nodes.is_blocked('mcp__messaging__messages_send',blocked,allowed))
        # Explicit allow_tools remains an intentional, separately configured override.
        self.assertFalse(engine.nodes.is_blocked('mcp__messaging__messages_send',blocked,{'mcp__messaging__messages_send'}))

    def test_no_builtin_claims_to_send_messages_without_a_supported_transport(self):
        engine=helpers.load_engine()
        env=engine.env.Env(ctx=helpers.FakeCtx(),state={'tool_source':lambda:[]})
        names={entry['type'] for entry in engine.nodes.list_node_types(env)}
        self.assertNotIn('output.send_message',names)
        self.assertNotIn('tool:send_message',names)

    def test_the_raw_bridge_tool_stays_blocked_while_the_dedicated_node_is_offered(self):
        engine=helpers.load_engine()
        tool=lambda name:{'name':name,'toolset':'mcp-messaging','parameters':{'type':'object','properties':{}}}
        env=engine.env.Env(ctx=helpers.FakeCtx(),state={'tool_source':lambda:[tool('mcp__messaging__channels_list'),
                                                                               tool('mcp__messaging__messages_send')]})
        names={entry['type'] for entry in engine.nodes.list_node_types(env)}
        self.assertNotIn('tool:mcp__messaging__messages_send',names)
        self.assertIn('tool:mcp__messaging__channels_list',names)
        self.assertIn('output.send_message',names)
        self.assertTrue(engine.nodes.is_blocked('mcp__messaging__messages_send',
                                                set(engine.nodes.DEFAULT_BLOCKED),set()))
        # allow_tools still wins, so a user can deliberately expose the raw tool
        self.assertFalse(engine.nodes.is_blocked('mcp__messaging__messages_send',
                                                 set(engine.nodes.DEFAULT_BLOCKED),
                                                 {'mcp__messaging__messages_send'}))
