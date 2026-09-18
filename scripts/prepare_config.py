"""Create application-owned secrets once, without printing them."""
import json
import os
import secrets
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / ".deploy"


def prepare():
    DIRECTORY.mkdir(exist_ok=True)
    path = DIRECTORY / "secrets.json"
    values = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    for key in ("AGENT_TOKEN", "APP_ADMIN_TOKEN"):
        if not values.get(key):
            values[key] = secrets.token_urlsafe(48)
    path.write_text(json.dumps(values, indent=2) + "\n", encoding="utf-8")
    os.chmod(path, 0o600)
    return values


if __name__ == "__main__":
    prepare()
    print("Application tokens ready: .deploy/secrets.json (git-ignored)")
