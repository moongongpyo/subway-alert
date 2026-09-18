import copy
import io
import json
import unittest
from datetime import datetime, timezone, timedelta
from unittest.mock import patch
import route_worker as rw


def leg(identity, mode, route, stops):
    return {"id":identity,"mode":mode,"route":route,"routeId":route,"type":2 if mode=="SUBWAY" else 11,
            "start":stops[0],"end":stops[-1],"durationSeconds":300,"service":"SCHEDULED","stops":[{"id":s,"name":s} for s in stops]}


def sample(role="detector"):
    subway=leg("l1","SUBWAY","2호선",["A","B","C"])
    bus=leg("l2","BUS","버스A",["D","E","F"])
    def journey(i, duration, l): return {"id":i,"totalSeconds":duration,"transfers":0,"walkSeconds":100,"legs":[l]}
    return {"requestId":"test","role":role,"attempt":0,"proposal":None,"blocks":[],
            "plan":{"provider":"DEMO","fetchedAt":datetime.now(timezone.utc).isoformat(),"journeys":[journey("r1",600,subway),journey("r2",900,bus)]}}


class RouteWorkerTests(unittest.TestCase):
    def test_independent_avoidance_and_no_alternative(self):
        job=sample()
        self.assertEqual("r1",rw.analyze_route(job,"detector","","test")["routeId"])
        for route in job["plan"]["journeys"]:
            job["blocks"].append({"scope":"SEGMENT","leg":route["legs"][0]})
        self.assertEqual("NO_ALTERNATIVE",rw.analyze_route(job,"detector","","test")["verdict"])

    def test_verifier_requests_revision_for_blocked_proposal(self):
        job=sample("verifier")
        job["blocks"]=[{"scope":"SEGMENT","leg":job["plan"]["journeys"][0]["legs"][0]}]
        job["proposal"]={"routeId":"r1","verdict":"PROPOSE"}
        decision=rw.analyze_route(job,"verifier","","test")
        self.assertEqual("REVISE",decision["verdict"])
        self.assertEqual("r2",decision["routeId"])
        job["proposal"]={"routeId":"r2","verdict":"PROPOSE"}
        self.assertEqual("APPROVED",rw.analyze_route(job,"verifier","","test")["verdict"])

    def test_reverse_edge_and_incomplete_stop_list_fail_closed(self):
        denied=leg("a","BUS","버스A",["A","B","C"])
        reverse=leg("b","BUS","버스B",["C","B","A"])
        self.assertTrue(rw.conflict(reverse,{"scope":"SEGMENT","leg":denied}))
        reverse["stops"]=[]
        self.assertTrue(rw.conflict(reverse,{"scope":"SEGMENT","leg":denied}))

    def test_stale_or_real_routes_without_key_are_rejected(self):
        job=sample(); job["plan"]["provider"]="TMAP"
        with self.assertRaises(RuntimeError): rw.analyze_route(job,"detector","","test")
        job["plan"]["fetchedAt"]=(datetime.now(timezone.utc)-timedelta(minutes=6)).isoformat()
        with self.assertRaises(ValueError): rw.analyze_route(job,"detector","test","test")

    def test_model_must_use_tools_and_cannot_invent_routes(self):
        facts=rw.assess_routes(sample())
        for value, seen in [({"routeId":"imaginary","verdict":"PROPOSE","reason":"x"},{"read_routes","check_avoidance"}),
                            ({"routeId":"r1","verdict":"PROPOSE","reason":"x"},set())]:
            with self.assertRaises(ValueError): rw.validate(value,facts,"detector",None,seen)

    def test_actual_function_protocol_with_mock_model(self):
        sequence=[("read_routes",{}),("check_avoidance",{}),("submit_route",{"routeId":"r1","verdict":"PROPOSE","reason":"제공된 후보 중 가장 짧은 경로"})]
        calls=[]
        def model(request, timeout):
            payload=json.loads(request.data); calls.append(payload)
            name,args=sequence.pop(0)
            return io.BytesIO(json.dumps({"output":[{"type":"function_call","name":name,"call_id":name,"arguments":json.dumps(args)}]}).encode())
        with patch.object(rw.urllib.request,"urlopen",side_effect=model):
            result=rw.analyze_route(sample(),"detector","test","test-model")
        self.assertEqual("openai",result["engine"])
        self.assertEqual(2,len(result["tools"]))
        self.assertTrue(any(i.get("type")=="function_call_output" for i in calls[-1]["input"]))


if __name__ == "__main__": unittest.main()
