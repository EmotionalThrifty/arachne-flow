"""Messaging node contract: an explicit, persistent target opt-in protects an official MCP egress."""
import asyncio
import copy
import json
import unittest
import threading
import helpers

E = helpers.load_engine()
TOOLS = [
    {"name":"mcp__messaging__channels_list", "toolset":"mcp-messaging", "parameters":{"type":"object","properties":{"platform":{"type":"string"}}}},
    {"name":"mcp__messaging__messages_send", "toolset":"mcp-messaging", "parameters":{"type":"object","properties":{"target":{"type":"string"},"message":{"type":"string"}},"required":["target","message"]}},
    {"name":"mcp__messaging__list_prompts", "toolset":"mcp-messaging", "parameters":{"type":"object","properties":{}}},
]

def make_env(handler=None):
    calls=[]
    def send(args):
        calls.append(args)
        if handler:
            return handler(args)
        return json.dumps({"success":True,"platform":"signal","target":"+491234","chunks":1})
    tools={"mcp__messaging__channels_list":lambda args:json.dumps({"count":2,"channels":[{"target":"signal:+491234","platform":"signal","name":"Arachne test","chat_type":"direct"},{"target":"signal:+499999","platform":"signal","name":"Other","chat_type":"direct"}]}),"mcp__messaging__messages_send":send}
    env=E.env.Env(ctx=helpers.FakeCtx(tools),state={"tool_source":lambda:copy.deepcopy(TOOLS)},
                  data_dir=helpers.temp_data_dir())
    return env,calls

TEST_FLOW_ID = "f_0123456789"


def run(env,params,inputs=None,flow_id=TEST_FLOW_ID,node_id="n_test"):
    spec=E.nodes.get_type(env,"output.send_message")
    n=E.executors.NodeContext("r_0123456789",node_id,E.store.outputs_dir(env, "r_0123456789"),flow_id=flow_id,log=lambda message:None)
    return asyncio.run(E.executors.execute(env,{"id":node_id,"type":"output.send_message","params":params},spec,inputs or {},n))

def armed(env, target="signal:+491234",flow_id=TEST_FLOW_ID,node_id="n_test"):
    """Authorize through the real persisted opt-in route, not a synthetic snapshot token."""
    if not E.store.flow_exists(env, flow_id):
        flow = E.graph.new_flow(flow_id=flow_id)
        flow["nodes"] = [{"id": node_id, "type": E.messaging.NODE_TYPE, "x": 0, "y": 0,
                          "params": {"target": target}}]
        E.store.save_flow(env, flow, create=True)
    else:
        def mutate(flow):
            node = next((n for n in flow["nodes"] if n.get("id") == node_id), None)
            if node is None:
                flow["nodes"].append({"id": node_id, "type": E.messaging.NODE_TYPE, "x": 0, "y": 0,
                                      "params": {"target": target}})
            else:
                node["params"]["target"] = target
        E.store.modify_flow(env, flow_id, mutate)
    return api(env, flow_id, {"node_id": node_id, "enable": True})["node"]["params"]


def api(env, flow_id, body):
    return asyncio.run(E.api.handle("POST", "flows/%s/messaging-optin" % flow_id, {}, body, env))


def saved_flow(env, nodes):
    flow = E.store.save_flow(env, E.graph.new_flow(), create=True)
    flow["nodes"] = nodes
    return E.store.save_flow(env, flow)


class MessagingTest(unittest.TestCase):
    def test_dedicated_node_requires_two_registered_tools_and_never_caches(self):
        env,_=make_env()
        spec=E.nodes.get_type(env,"output.send_message")
        self.assertIsNotNone(spec)
        self.assertEqual(spec["category"],"Output")
        self.assertFalse(spec["cacheable"])
        self.assertFalse(spec["cache_default"])
        self.assertTrue(spec["params"][0]["required"])
        self.assertFalse(spec["params"][1]["required"])
        self.assertTrue(spec["params"][2]["required"])
        self.assertEqual([p["name"] for p in spec["inputs"]],["message", "attachment"])
        empty=E.env.Env(ctx=helpers.FakeCtx(),state={"tool_source":lambda:[]})
        self.assertIsNone(E.nodes.get_type(empty,"output.send_message"))
        self.assertEqual(E.nodes.list_node_types(empty),E.nodes.list_node_types(empty))
        self.assertIsNone(E.nodes.get_type(empty,"tool:mcp__messaging__list_prompts"))

    def test_inspector_hides_internal_authorization_params(self):
        env, _ = make_env()
        spec = E.nodes.get_type(env, "output.send_message")
        fields = {field["name"]: field for field in spec["params"]}
        self.assertTrue(fields["send_enabled"].get("hidden"))
        self.assertTrue(fields["authorized_target"].get("hidden"))
        self.assertFalse(fields["target"].get("hidden", False))
        self.assertEqual(fields["target"]["options_source"], "messaging_channels")

    def test_channel_directory_parses_names_targets_and_metadata(self):
        env,_=make_env()
        data=asyncio.run(E.api.handle("GET","options",{"type":"output.send_message","param":"target"},{},env))
        self.assertEqual(len(data["options"]),2)
        self.assertEqual(data["options"][0]["value"],"signal:+491234")
        self.assertIn("Arachne test",data["options"][0]["label"])
        self.assertIn("Signal",data["options"][0]["label"])
        self.assertIn("Direct",data["options"][0]["label"])

    def test_channel_options_nested_mcp_reply_and_boundary_handling(self):
        nested_payload = {
            "result": json.dumps({
                "count": 1,
                "channels": [{
                    "target": "signal:+491234",
                    "platform": "signal",
                    "name": "Example",
                    "chat_type": "dm",
                }],
            }),
            "structuredContent": {"result": "ok"},
        }
        tools = {
            "mcp__messaging__channels_list": lambda args: json.dumps(nested_payload),
            "mcp__messaging__messages_send": lambda args: json.dumps({"success": True}),
        }
        env = E.env.Env(ctx=helpers.FakeCtx(tools), state={"tool_source": lambda: copy.deepcopy(TOOLS)})
        res = asyncio.run(E.api.handle("GET", "options", {"type": "output.send_message", "param": "target"}, {}, env))
        opts = res if isinstance(res, list) else res.get("options", res.get("data", []))
        self.assertEqual(len(opts), 1)
        self.assertEqual(opts[0]["value"], "signal:+491234")
        self.assertEqual(opts[0]["group"], "Signal")
        self.assertIn("Example", opts[0]["label"])

        chan_fn = getattr(getattr(E, "messaging", E), "channel_options", None)
        if chan_fn:
            self.assertEqual(chan_fn(nested_payload)[0]["value"], "signal:+491234")
            text_mcp = {"content": [{"type": "text", "text": json.dumps({"channels": [{"target": "signal:+491234"}]})}]}
            self.assertEqual(chan_fn(text_mcp)[0]["value"], "signal:+491234")
            str_payload = json.dumps({"channels": [{"target": "signal:+491234"}]})
            self.assertEqual(chan_fn(str_payload)[0]["value"], "signal:+491234")
            self.assertEqual(chan_fn(None), [])
            self.assertEqual(chan_fn("{invalid json"), [])
            self.assertEqual(chan_fn({"channels": "invalid"}), [])
            deep = {"result": {"result": {"result": {"result": {"result": {"result": {"result": {"channels": [{"target": "signal:+1"}]}}}}}}}}
            self.assertEqual(chan_fn(deep), [])

    def test_recipient_options_do_not_reuse_a_parser_from_before_engine_reload(self):
        env, calls = make_env()
        E.nodes.get_type(env, 'output.send_message')
        # Env.state survives engine reload; this models the older parser callback.
        env.state['options_sources']['messaging_channels']['result_adapter'] = lambda result: []
        data = asyncio.run(E.api.handle('GET', 'options',
            {'type': 'output.send_message', 'param': 'target', 'refresh': '1'}, {}, env))
        self.assertEqual(len(data['options']), 2)
        self.assertIn('Arachne test', data['options'][0]['label'])
        self.assertEqual(calls, [])

    def test_recipient_registry_refresh_replaces_legacy_callback_with_data(self):
        env, calls = make_env()
        E.nodes.get_type(env, 'output.send_message')
        env.state['options_sources']['messaging_channels']['result_adapter'] = lambda result: []
        E.nodes.list_node_types(env, fresh=True)
        source = env.state['options_sources']['messaging_channels']
        self.assertEqual(source['tool'], E.messaging.CHANNEL_TOOL)
        self.assertNotIn('result_adapter', source)
        self.assertEqual(calls, [])

    def test_target_opt_in_is_persistent_and_recipient_changes_reset_it(self):

        flow=E.graph.new_flow()
        flow["nodes"]=[{"id":"n_000001","type":"output.send_message","params":{"target":"signal:+491234","send_enabled":False}}]
        updated=E.graph.messaging_params(flow["nodes"][0],{"target":"signal:+499999"})
        self.assertFalse(updated["send_enabled"])
        self.assertFalse(E.graph.refresh_ids(flow)["nodes"][0]["params"]["send_enabled"])
        source=E.store.template_from_flow(flow)
        self.assertFalse(source["nodes"][0]["params"]["send_enabled"])

    def test_send_is_off_by_default_even_with_a_target(self):
        env,calls=make_env()
        with self.assertRaisesRegex(E.executors.NodeError,"Enable sending"):
            run(env,{"target":"signal:+491234"}, {"message":"Synthetic test"})
        self.assertEqual(calls,[])

    def test_rejects_target_change_and_wired_target_without_sending(self):
        env,calls=make_env()
        with self.assertRaisesRegex(E.executors.NodeError,"recipient changed"):
            run(env,{**armed(env),"authorized_target":"signal:+499999"},{"message":"Test"})
        with self.assertRaisesRegex(E.executors.NodeError,"fixed in the node settings"):
            run(env,armed(env),{"target":"signal:+499999","message":"Test"})
        self.assertEqual(calls,[])

    def test_a_written_pair_without_a_minted_token_is_refused(self):
        env,calls=make_env()
        forged={"target":"signal:+491234","send_enabled":True,"authorized_target":"signal:+491234","optin_token":"0"*64}
        with self.assertRaisesRegex(E.executors.NodeError,"not authorized"):
            run(env,forged,{"message":"Test"})
        self.assertEqual(calls,[])

    def test_partial_registration_does_not_offer_the_node(self):
        env,_=make_env()
        only_channels=[t for t in TOOLS if t["name"]!="mcp__messaging__messages_send"]
        env.state["tool_source"]=lambda:copy.deepcopy(only_channels)
        self.assertIsNone(E.nodes.get_type(env,"output.send_message"))

    def test_requires_the_mcp_tool_and_plain_text_message(self):
        env,calls=make_env()
        good=armed(env)
        missing=E.env.Env(ctx=helpers.FakeCtx(),state={"tool_source":lambda:[]})
        missing_spec=dict(E.nodes.get_type(env,"output.send_message"))
        with self.assertRaisesRegex(E.executors.NodeError,"not available"):
            asyncio.run(E.executors.execute(missing,{"id":"n_test","type":"output.send_message","params":good},missing_spec,{"message":"Test"},E.executors.NodeContext("r_test","n_test","unused",flow_id=TEST_FLOW_ID,log=lambda message:None)))
        with self.assertRaisesRegex(E.executors.NodeError,"plain text"):
            run(env,good,{"message":{"text":"nested"}})
        with self.assertRaisesRegex(E.executors.NodeError,"MEDIA:"):
            run(env,good,{"message":"MEDIA:C:/Users/example/secret.png"})
        self.assertEqual(calls,[])

    def test_explicit_opt_in_dispatches_only_message_send(self):
        env,calls=make_env()
        result=run(env,armed(env),{"message":"Synthetic offline test"})
        self.assertEqual(calls,[{"target":"signal:+491234","message":"Synthetic offline test"}])
        self.assertEqual(result["result"]["chunks"],1)
        self.assertIn("Delivery reported",result["text"])
        self.assertEqual(result["media"],None)

    def test_failure_is_not_success(self):
        env,calls=make_env(lambda a:json.dumps({"error":"synthetic delivery failure"}))
        with self.assertRaisesRegex(E.executors.NodeError,"synthetic delivery failure"):
            run(env,armed(env),{"message":"Test"})
        self.assertEqual(len(calls),1)

    def test_timeout_is_unconfirmed_no_automatic_retry(self):
        # Synchronize actual host entry: a 10 ms budget can now expire safely during
        # persisted-consent I/O, which is a different (also covered) no-dispatch case.
        started, release = threading.Event(), threading.Event()
        def slow(_):
            started.set()
            release.wait(3)
            return json.dumps({"success": True})
        env,calls=make_env(slow)
        params={**armed(env),"timeout_s":1}
        node={"id":"n_test","type":"output.send_message","params":params}
        ctx=E.executors.NodeContext("r_test","n_test","unused",flow_id=TEST_FLOW_ID,log=lambda _:None)
        async def scenario():
            task=asyncio.create_task(E.executors.execute(env,node,E.messaging.spec(),{"message":"Test"},ctx))
            try:
                self.assertTrue(await asyncio.to_thread(started.wait,.8), "host did not start before timeout")
                with self.assertRaisesRegex(E.executors.NodeError,"unconfirmed.*Do not re-run"):
                    await task
            finally:
                release.set()
            await asyncio.sleep(.02)
        asyncio.run(scenario())
        self.assertEqual(len(calls),1)

    def test_two_runs_do_not_serve_a_cached_delivery(self):
        env,calls=make_env()
        params=armed(env)
        self.assertFalse(E.runner.node_cacheable({"params":params},{"cacheable":False,"cache_default":False},False))
        run(env,params,{"message":"Test"});run(env,params,{"message":"Test"})
        self.assertEqual(len(calls),2)

    def test_optin_route_arms_and_disarms_in_one_locked_revision(self):
        env,_=make_env()
        flow=saved_flow(env,[{"id":"n_000001","type":"output.send_message","x":0,"y":0,"params":{"target":"signal:+491234"}}])
        node_id="n_000001"
        on=api(env,flow["id"],{"node_id":node_id,"enable":True,"base_revision":flow["revision"]})
        params=on["node"]["params"]
        self.assertTrue(params["send_enabled"])
        self.assertEqual(params["authorized_target"],"signal:+491234")
        self.assertTrue(E.messaging.token_matches(env,flow["id"],node_id,params))
        self.assertEqual(on["flow"]["revision"],flow["revision"]+1)
        off=api(env,flow["id"],{"node_id":node_id,"enable":False,"base_revision":on["flow"]["revision"]})
        self.assertFalse(off["node"]["params"]["send_enabled"])
        self.assertNotIn("optin_token",off["node"]["params"])
        self.assertEqual(E.store.get_flow(env,flow["id"]),off["flow"])

    def test_real_runner_passes_flow_and_node_consent_context(self):
        env,calls=make_env()
        flow=saved_flow(env,[{"id":"n_000001","type":"output.send_message","x":0,"y":0,
                             "params":{"target":"signal:+491234","message":"Synthetic test"}}])
        enabled=api(env,flow["id"],{"node_id":"n_000001","enable":True})["flow"]
        enabled["nodes"][0]["params"]["message"]="Edited synthetic test"
        edited=E.store.save_flow(env,enabled,base_revision=enabled["revision"])
        self.assertTrue(edited["nodes"][0]["params"]["send_enabled"])
        result=E.runner.run_sync(env,edited["id"])
        self.assertEqual(result["nodes"]["n_000001"]["status"],"done")
        self.assertEqual(calls,[{"target":"signal:+491234","message":"Edited synthetic test"}])

    def test_optin_route_refuses_a_non_messaging_node_or_missing_target(self):
        env,_=make_env()
        flow=saved_flow(env,[{"id":"n_000001","type":"input.text","x":0,"y":0,"params":{"value":"x"}},
                             {"id":"n_000002","type":"output.send_message","x":0,"y":0,"params":{}}])
        for node_id,message in (("n_000001","Send message"),("n_000002","recipient")):
            with self.assertRaisesRegex(E.api.HTTPException,message):
                api(env,flow["id"],{"node_id":node_id,"enable":True})
        self.assertFalse(E.store.get_flow(env,flow["id"])["nodes"][1]["params"].get("send_enabled"))

    def test_the_write_path_disarms_a_written_authorization(self):
        env,_=make_env()
        saved=saved_flow(env,[{"id":"n_000001","type":"output.send_message","x":0,"y":0,
                               "params":{"target":"signal:+491234","send_enabled":True,"authorized_target":"signal:+491234"}}])
        self.assertFalse(saved["nodes"][0]["params"]["send_enabled"])
        self.assertNotIn("authorized_target",saved["nodes"][0]["params"])
        self.assertNotIn("optin_token",saved["nodes"][0]["params"])
        with self.assertRaisesRegex(E.executors.NodeError,"Enable sending"):
            run(env,saved["nodes"][0]["params"],{"message":"Test"})

    def test_nested_mcp_failures_are_not_success(self):
        failure={"success":False,"error":"synthetic nested failure"}
        replies=[
            {"result":json.dumps(failure)},
            {"structuredContent":{"result":json.dumps(failure)}},
            {"content":[{"type":"text","text":json.dumps(failure)}]},
        ]
        for reply in replies:
            with self.subTest(reply=reply):
                env,calls=make_env(lambda a:json.dumps(reply))
                with self.assertRaisesRegex(E.executors.NodeError,"synthetic nested failure"):
                    run(env,armed(env),{"message":"Test"})
                self.assertEqual(len(calls),1)

    def test_copied_authorization_cannot_arm_another_node_or_flow(self):
        env,calls=make_env()
        first=saved_flow(env,[{"id":"n_000001","type":"output.send_message","x":0,"y":0,"params":{"target":"signal:+491234"}}])
        enabled=api(env,first["id"],{"node_id":"n_000001","enable":True})["flow"]
        first["nodes"].append({"id":"n_000002","type":"output.send_message","x":0,"y":0,
                              "params":copy.deepcopy(enabled["nodes"][0]["params"])})
        saved=E.store.save_flow(env,first)
        self.assertFalse(saved["nodes"][1]["params"]["send_enabled"])
        with self.assertRaisesRegex(E.executors.NodeError,"sending|authorized"):
            run(env,saved["nodes"][1]["params"],{"message":"Test"})
        other=E.store.save_flow(env,E.graph.new_flow(),create=True)
        other["nodes"]=[copy.deepcopy(enabled["nodes"][0])]
        saved_other=E.store.save_flow(env,other)
        self.assertFalse(saved_other["nodes"][0]["params"]["send_enabled"])
        with self.assertRaisesRegex(E.executors.NodeError,"sending|authorized"):
            run(env,saved_other["nodes"][0]["params"],{"message":"Test"})
        self.assertEqual(calls,[])

    def test_revoked_authorization_cannot_be_restored_by_a_generic_write(self):
        env,calls=make_env()
        flow=saved_flow(env,[{"id":"n_000001","type":"output.send_message","x":0,"y":0,"params":{"target":"signal:+491234"}}])
        old=api(env,flow["id"],{"node_id":"n_000001","enable":True})["flow"]
        off=api(env,flow["id"],{"node_id":"n_000001","enable":False,"base_revision":old["revision"]})["flow"]
        restored=E.store.save_flow(env,old,base_revision=off["revision"])
        self.assertFalse(restored["nodes"][0]["params"]["send_enabled"])
        self.assertNotIn("optin_token",restored["nodes"][0]["params"])
        with self.assertRaisesRegex(E.executors.NodeError,"sending|authorized"):
            run(env,restored["nodes"][0]["params"],{"message":"Test"})
        self.assertEqual(calls,[])

    def test_execution_requires_flow_and_node_consent_context(self):
        env,calls=make_env()
        flow=saved_flow(env,[{"id":"n_000001","type":"output.send_message","x":0,"y":0,"params":{"target":"signal:+491234"}}])
        enabled=api(env,flow["id"],{"node_id":"n_000001","enable":True})["flow"]
        params=enabled["nodes"][0]["params"]
        without_context=E.executors.NodeContext("r_test","n_000001","unused",log=lambda message:None)
        with self.assertRaisesRegex(E.executors.NodeError,"sending|authorized"):
            asyncio.run(E.executors.execute(env,enabled["nodes"][0],E.messaging.spec(),{"message":"Test"},without_context))
        self.assertEqual(calls,[])

    def test_revocation_and_reenable_invalidate_a_running_old_snapshot(self):
        env,calls=make_env()
        flow=saved_flow(env,[{"id":"n_000001","type":"output.send_message","x":0,"y":0,
                             "params":{"target":"signal:+491234","message":"Synthetic"}}])
        first=api(env,flow["id"],{"node_id":"n_000001","enable":True})["flow"]
        snapshot=copy.deepcopy(first)
        api(env,flow["id"],{"node_id":"n_000001","enable":False})
        ctx=E.executors.NodeContext("r_test","n_000001","unused",flow_id=flow["id"],log=lambda message:None)
        async def execute_old():
            return await E.executors.execute(env,snapshot["nodes"][0],E.messaging.spec(),{"message":"Synthetic"},ctx)
        with self.assertRaisesRegex(E.executors.NodeError,"authoriz|consent|enabled"):
            asyncio.run(execute_old())
        renewed=api(env,flow["id"],{"node_id":"n_000001","enable":True})["flow"]
        self.assertNotEqual(snapshot["nodes"][0]["params"]["optin_token"],renewed["nodes"][0]["params"]["optin_token"])
        with self.assertRaisesRegex(E.executors.NodeError,"authoriz|consent|enabled"):
            asyncio.run(execute_old())
        self.assertEqual(calls,[])

    def test_legacy_invalid_token_is_not_displayed_as_armed(self):
        import hashlib
        import hmac
        env,_=make_env()
        flow=saved_flow(env,[{"id":"n_000001","type":"output.send_message","x":0,"y":0,
                             "params":{"target":"signal:+491234"}}])
        current=api(env,flow["id"],{"node_id":"n_000001","enable":True})["flow"]
        current["nodes"][0]["params"]["optin_token"]=hmac.new(
            E.messaging._secret(env),b"send-message\x1fsignal:+491234",hashlib.sha256).hexdigest()
        path=E.store._flow_path(env,flow["id"])
        E.store.write_json(path,current)
        before=E.store.read_json(path)
        view=asyncio.run(E.api.handle("GET","flows/"+flow["id"],{},{},env))["flow"]
        self.assertFalse(view["nodes"][0]["params"]["send_enabled"])
        self.assertNotIn("optin_token",view["nodes"][0]["params"])
        self.assertEqual(E.store.read_json(path),before)
        self.assertEqual(view["revision"],before["revision"])

    def test_unparseable_skipped_and_unconfirmed_receipts_never_report_delivery(self):
        receipts=("not-json",'{"result":"{broken"}',"{}",
                  json.dumps({"success":True,"skipped":True,"reason":"synthetic duplicate"}),
                  json.dumps({"result":json.dumps({"success":True,"delivery_unconfirmed":"No platform confirmation"})}))
        for receipt in receipts:
            with self.subTest(receipt=receipt):
                env,calls=make_env(lambda _:receipt)
                flow=saved_flow(env,[{"id":"n_000001","type":"output.send_message","x":0,"y":0,
                                     "params":{"target":"signal:+491234"}}])
                enabled=api(env,flow["id"],{"node_id":"n_000001","enable":True})["flow"]
                ctx=E.executors.NodeContext("r_test","n_000001","unused",flow_id=flow["id"],log=lambda message:None)
                with self.assertRaisesRegex(E.executors.NodeError,"unconfirmed|skipped|uncertain"):
                    asyncio.run(E.executors.execute(env,enabled["nodes"][0],E.messaging.spec(),{"message":"Synthetic"},ctx))
                self.assertEqual(len(calls),1)

    def test_timeout_after_host_dispatch_started_is_unconfirmed_and_not_retried(self):
        import time
        env,calls=make_env(lambda args:(time.sleep(.2),json.dumps({"success":True}))[1])
        flow=saved_flow(env,[{"id":"n_000001","type":"output.send_message","x":0,"y":0,
                             "params":{"target":"signal:+491234","timeout_s":0.03}}])
        enabled=api(env,flow["id"],{"node_id":"n_000001","enable":True})["flow"]
        ctx=E.executors.NodeContext("r_test","n_000001","unused",flow_id=flow["id"],log=lambda message:None)
        with self.assertRaisesRegex(E.executors.NodeError,"unconfirmed.*Do not re-run"):
            asyncio.run(E.executors.execute(env,enabled["nodes"][0],E.messaging.spec(),{"message":"Synthetic"},ctx))
        self.assertEqual(len(calls),1)

    def test_queued_send_must_not_dispatch_after_timeout(self):
        import threading
        env,calls=make_env()
        flow=saved_flow(env,[{"id":"n_000001","type":"output.send_message","x":0,"y":0,
                             "params":{"target":"signal:+491234","timeout_s":0.05}}])
        enabled=api(env,flow["id"],{"node_id":"n_000001","enable":True})["flow"]
        node=enabled["nodes"][0]
        ctx=E.executors.NodeContext("r_test","n_000001","unused",flow_id=flow["id"],log=lambda message:None)
        lock=E.store.flow_lock(env,flow["id"])
        started=threading.Event()
        done=threading.Event()
        observed=[]
        def worker():
            started.set()
            try:
                asyncio.run(E.executors.execute(env,node,E.messaging.spec(),{"message":"Synthetic"},ctx))
                observed.append("delivered")
            except E.executors.NodeError as exc:
                observed.append(str(exc))
            finally:
                done.set()
        with lock:
            thread=threading.Thread(target=worker,daemon=True)
            thread.start()
            self.assertTrue(started.wait(1))
            self.assertTrue(done.wait(2),"node must timeout while consent store is locked")
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        # A timed-out worker must not call the host later, after the lock is released.
        import time
        time.sleep(.2)
        self.assertEqual(calls,[])
        self.assertEqual(len(observed),1)
        self.assertIn("unconfirmed",observed[0])

    def test_a_changed_target_disarms_on_the_write_path(self):
        env,_=make_env()
        flow=saved_flow(env,[{"id":"n_000001","type":"output.send_message","x":0,"y":0,"params":{"target":"signal:+491234"}}])
        armed_flow=api(env,flow["id"],{"node_id":"n_000001","enable":True})["flow"]
        armed_flow["nodes"][0]["params"]["target"]="signal:+499999"
        saved=E.store.save_flow(env,armed_flow)
        self.assertFalse(saved["nodes"][0]["params"]["send_enabled"])
        self.assertNotIn("optin_token",saved["nodes"][0]["params"])


if __name__=="__main__":unittest.main()
