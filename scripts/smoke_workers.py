"""Exercise Spring -> detector HTTP -> verifier HTTP -> requery -> notification, no paid keys."""
import http.cookiejar
import json
import os
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def run():
    main_port, detector_port, verifier_port = port(), port(), port()
    secret = secrets.token_urlsafe(32)
    java = str(Path(os.environ["JAVA_HOME"])/"bin"/("java.exe" if os.name == "nt" else "java")) if os.getenv("JAVA_HOME") else "java"
    jar = next(p for p in (ROOT/"build/libs").glob("*.jar") if not p.name.endswith("-plain.jar"))
    children = []
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def request(path, body=None):
        req = urllib.request.Request(f"http://127.0.0.1:{main_port}"+path, None if body is None else json.dumps(body).encode(),
                                     {"Content-Type": "application/json", "X-Requested-With": "SubwayAlert", "X-Admin-Token": secret})
        with opener.open(req, timeout=5) as response:
            return json.load(response)
    with tempfile.TemporaryDirectory(prefix="subway-workers-") as tmp:
        log_path = Path(tmp)/"process.log"
        with log_path.open("wb") as log:
            options = {"cwd": str(ROOT), "stdout": log, "stderr": log}
            if os.name == "nt": options["creationflags"] = subprocess.CREATE_NO_WINDOW
            try:
                for role, worker_port in [("detector",detector_port),("verifier",verifier_port)]:
                    env = dict(os.environ, AGENT_ROLE=role, AGENT_TOKEN=secret, PORT=str(worker_port), OPENAI_API_KEY="")
                    # Windows venv launchers can leave a child interpreter behind; use the base interpreter for this stdlib worker.
                    children.append(subprocess.Popen([getattr(os.sys,"_base_executable",os.sys.executable),str(ROOT/"agents/worker.py")],env=env,**options))
                env = dict(os.environ, APP_ADMIN_TOKEN=secret, AGENT_TOKEN=secret, APP_MODE="DEMO", SEOUL_API_KEY="", TMAP_APP_KEY="", PORT=str(main_port),
                           DETECTOR_URL=f"http://127.0.0.1:{detector_port}", VERIFIER_URL=f"http://127.0.0.1:{verifier_port}",
                           DETECTOR_PREVIEW_TOKEN="",VERIFIER_PREVIEW_TOKEN="",JDBC_DATABASE_URL="jdbc:h2:mem:workers",DB_USERNAME="sa",DB_PASSWORD="",DEMO_SEED="false")
                children.append(subprocess.Popen([java,"-jar",str(jar)],env=env,**options))
                for _ in range(90):
                    try:
                        if request("/actuator/health")["status"] == "UP": break
                    except Exception: time.sleep(.5)
                else: raise AssertionError("Spring health check timed out")
                request("/api/dashboard")
                request("/api/subscriptions",{"station":"역삼","direction":"내선"})
                request("/api/admin/scenarios",{"scenario":"DELAY","station":"역삼","direction":"내선","requestId":str(uuid.uuid4())})
                for _ in range(60):
                    data = request("/api/dashboard")
                    if not data["busy"]: break
                    time.sleep(.2)
                assert len(data["notifications"]) == 1, "Expected exactly one delay notification"
                assert len(data["jobs"]) == 4, "Expected A+B, requery, A+B"
                assert all(j["state"] == "SUCCEEDED" and j["engine"] == "simulation" for j in data["jobs"]), "Remote worker failed"
                assert any(m["type"] == "REQUEST_REFRESH" for m in data["messages"])
                assert data["settings"]["agentsConfigured"] is True
                print("PASS: Spring -> HTTP detector/verifier -> requery -> one notification (simulation)")
                route = request("/api/routes", {"from":{"name":"강남","lon":127.027619,"lat":37.497952},"to":{"name":"선릉","lon":127.048203,"lat":37.504286},"provider":"DEMO"})
                route_path = "/api/routes/"+route["id"]
                def finished_route():
                    for _ in range(60):
                        value = request(route_path)
                        if not value["busy"]: return value
                        time.sleep(.1)
                    raise AssertionError("Route agents timed out")
                route = finished_route()
                assert route["state"] == "VERIFIED" and route["recommendedId"] == "route-1", route
                for leg, expected in [("route-1-leg-0","route-2"),("route-2-leg-1","route-4"),("route-4-leg-1","")]:
                    request(route_path+"/avoid",{"legId":leg,"scope":"SEGMENT","reason":"이용 불가"})
                    route = finished_route()
                    assert route["recommendedId"] == expected, route
                    assert len(route["traces"]) == 2 and all(t["engine"] == "simulation" for t in route["traces"])
                assert route["state"] == "NO_ALTERNATIVE"
                print("PASS: Spring -> HTTP route planner/verifier -> subway avoidance -> bus avoidance -> no alternative")
            except Exception:
                # Logs from this keyless, temporary run contain no real credentials.
                print(log_path.read_text(encoding="utf-8",errors="replace")[-8000:])
                raise
            finally:
                for child in reversed(children):
                    child.terminate()
                    try: child.wait(timeout=10)
                    except subprocess.TimeoutExpired: child.kill(); child.wait()


if __name__ == "__main__":
    run()
