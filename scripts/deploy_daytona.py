"""Deploy both agent services; generate private Railway variables without printing secrets.

python scripts/deploy_daytona.py [--hours 24] [--stop]
Requires DAYTONA_API_KEY from the same organization as the sandboxes.
"""
import argparse
import json
import os
import shlex
import sys
import time
import urllib.request
from pathlib import Path
from daytona import Daytona, DaytonaConfig, CreateSandboxFromImageParams, Resources, SessionExecuteRequest
from dotenv import load_dotenv
from prepare_config import prepare, ROOT, DIRECTORY

load_dotenv(ROOT / ".env", override=False)
NAMES = {"detector": "subway-alert-detector", "verifier": "subway-alert-verifier"}
STATE = DIRECTORY / "daytona.json"


def save(state):
    STATE.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    os.chmod(STATE, 0o600)


def command(sandbox, value):
    result = sandbox.process.exec(value, timeout=30)
    if result.exit_code != 0:
        raise RuntimeError("Sandbox command failed. Inspect the service log in Daytona.")
    return result.result


def deploy(args):
    if not os.getenv("DAYTONA_API_KEY"):
        raise SystemExit("Set DAYTONA_API_KEY in .env or the current environment. See docs/KEYS.md.")
    secrets = prepare()
    client = Daytona(DaytonaConfig(api_key=os.environ["DAYTONA_API_KEY"], api_url=os.getenv("DAYTONA_API_URL", "https://app.daytona.io/api"), target=os.getenv("DAYTONA_TARGET", "us")))
    # A list failure is fatal, never interpreted as permission to create duplicates.
    existing = {s.name: s for s in client.list() if s.name in NAMES.values()}
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    server_env = {"APP_MODE": "DEMO", "AGENT_TOKEN": secrets["AGENT_TOKEN"], "APP_ADMIN_TOKEN": secrets["APP_ADMIN_TOKEN"], "SEOUL_API_KEY": os.getenv("SEOUL_API_KEY", "")}
    for role, name in NAMES.items():
        sandbox = existing.get(name)
        if args.stop:
            if sandbox:
                client.stop(sandbox)
                print(f"Stopped {name}; filesystem retained.")
            continue
        if sandbox is None:
            sandbox = client.create(CreateSandboxFromImageParams(name=name, image="python:3.12-slim", os_user="root", resources=Resources(cpu=1, memory=1, disk=3),
                                    labels={"app": "subway-alert", "role": role}, public=False, auto_stop_interval=args.hours*60, auto_delete_interval=-1), timeout=180)
        elif str(sandbox.state).lower().split('.')[-1] != "started":
            client.start(sandbox, timeout=120)
        state[role] = {"id": sandbox.id, "name": name}
        save(state)  # checkpoint before any upload; reruns reuse the same sandbox
        sandbox.set_autostop_interval(args.hours*60)
        command(sandbox, "mkdir -p /app/subway-alert && chmod 700 /app/subway-alert")
        stop_old = """import os,signal,time
from pathlib import Path
p=Path('/app/subway-alert/service.pid')
if p.exists():
 pid=int(p.read_text())
 proc=Path(f'/proc/{pid}/cmdline')
 if proc.exists() and b'sandbox_runner.py' in proc.read_bytes():
  os.kill(pid,signal.SIGTERM)
  for _ in range(20):
   if not p.exists(): break
   time.sleep(1)
  if p.exists(): raise RuntimeError('Old service did not stop; refusing a duplicate')
"""
        command(sandbox, "python -c " + shlex.quote(stop_old))
        for local, remote in [(ROOT/"agents/worker.py", "worker.py"), (ROOT/"scripts/sandbox_runner.py", "sandbox_runner.py")]:
            sandbox.fs.upload_file(str(local), "/app/subway-alert/"+remote)
        env = {"AGENT_ROLE": role, "AGENT_TOKEN": secrets["AGENT_TOKEN"], "OPENAI_API_KEY": os.getenv("OPENAI_API_KEY", ""), "OPENAI_MODEL": os.getenv("OPENAI_MODEL", "gpt-4.1-mini"), "PORT": "8000", "PYTHONUNBUFFERED": "1"}
        sandbox.fs.upload_file(json.dumps({"env": env, "command": ["python", "worker.py"], "run_hours": args.hours}).encode(), "/app/subway-alert/runtime.json")
        sandbox.fs.set_file_permissions("/app/subway-alert/runtime.json", mode="600")
        session = f"subway-{role}-{int(time.time())}"
        sandbox.process.create_session(session)
        sandbox.process.execute_session_command(session, SessionExecuteRequest(command="python /app/subway-alert/sandbox_runner.py", run_async=True))
        preview = sandbox.get_preview_link(8000)
        healthy = False
        for _ in range(20):
            try:
                req = urllib.request.Request(preview.url.rstrip('/')+"/health", headers={"x-daytona-preview-token": preview.token})
                with urllib.request.urlopen(req, timeout=10) as response:
                    result = json.load(response)
                healthy = result.get("status") == "ok" and result.get("role") == role
                if healthy: break
            except Exception:
                time.sleep(1)
        if not healthy:
            raise RuntimeError(f"{name} health check failed; inspect Daytona service.log. Existing sandbox preserved.")
        server_env[role.upper()+"_URL"] = preview.url
        server_env[role.upper()+"_PREVIEW_TOKEN"] = preview.token
        state[role].update({"url": preview.url, "engine": result["engine"], "session": session})
        save(state)
        print(f"Ready: {name} ({result['engine']}); auto-stop after {args.hours}h without Daytona activity.")
    if not args.stop:
        path = DIRECTORY / "railway.env"
        path.write_text("\n".join(f"{k}={v}" for k,v in server_env.items())+"\n", encoding="utf-8")
        os.chmod(path,0o600)
        print("Railway variables saved to .deploy/railway.env. Never commit or share this file.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--hours", type=int, choices=range(1,49), default=24)
    parser.add_argument("--stop", action="store_true")
    try:
        deploy(parser.parse_args())
    except Exception as error:
        # SDK exceptions can embed credentials/URLs. Print only the type here.
        print(f"Deployment stopped ({type(error).__name__}). Sandbox state retained in .deploy/daytona.json.", file=sys.stderr)
        sys.exit(1)
