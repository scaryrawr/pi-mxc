"""Exercise the installed pi CLI and /sandbox commands without model calls."""

import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading


ROOT = Path(__file__).resolve().parent.parent


class Rpc:
    def __init__(self, directory):
        workspace = directory / "workspace"
        workspace.mkdir()
        self.records = queue.Queue()
        self.sequence = 0
        self.process = subprocess.Popen(
            [
                "pi", "--mode", "rpc", "--no-session", "--offline",
                "--no-extensions", "--no-skills", "--no-prompt-templates",
                "--no-context-files", "--no-approve",
                "-e", str(ROOT / "extensions" / "mxc.ts"),
            ],
            cwd=workspace,
            env={**os.environ, "PI_CODING_AGENT_DIR": str(directory / "agent")},
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.diagnostics = []
        threading.Thread(target=self.read_records, daemon=True).start()
        threading.Thread(target=self.read_diagnostics, daemon=True).start()

    def read_records(self):
        for line in self.process.stdout:
            try:
                self.records.put(json.loads(line))
            except ValueError as error:
                self.records.put(error)
        self.records.put(RuntimeError("Pi closed stdout"))

    def read_diagnostics(self):
        for line in self.process.stderr:
            self.diagnostics.append(line.decode("utf8", errors="replace"))

    def send(self, record):
        self.process.stdin.write(json.dumps(record).encode("utf8") + b"\n")
        self.process.stdin.flush()

    def request(self, command, editor_response=None, cancel_editor=False):
        self.sequence += 1
        request_id = str(self.sequence)
        self.send({**command, "id": request_id})
        notifications = []
        while True:
            try:
                record = self.records.get(timeout=20)
            except queue.Empty:
                raise AssertionError("RPC timeout: " + "".join(self.diagnostics))
            if isinstance(record, Exception):
                raise record
            if record.get("type") == "extension_ui_request":
                if record.get("method") == "notify":
                    notifications.append(record)
                elif record.get("method") == "editor":
                    if cancel_editor:
                        response = {"cancelled": True}
                    else:
                        assert editor_response is not None, "Unexpected editor request"
                        response = {"value": editor_response}
                    self.send({"type": "extension_ui_response", "id": record["id"], **response})
            if record.get("type") == "response" and record.get("id") == request_id:
                return record, notifications

    def command(self, text, **kwargs):
        response, notifications = self.request({"type": "prompt", "message": text}, **kwargs)
        assert response["success"], response
        assert response["data"]["disposition"] == "handled", response
        return notifications

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.process.stdout.close()
        self.process.stderr.close()


def main():
    with tempfile.TemporaryDirectory(prefix="pi-mxc-rpc-") as temporary:
        directory = Path(temporary)
        config_path = directory / "agent" / "pi-mxc.json"
        client = Rpc(directory)
        try:
            response, _ = client.request({"type": "get_commands"})
            assert any(c["name"] == "sandbox" for c in response["data"]["commands"]), response
            assert not config_path.exists(), "Loading the extension wrote the config"

            client.command("/sandbox init")
            initial = json.loads(config_path.read_text())
            assert initial["enabled"] is True
            original = config_path.read_text()
            notifications = client.command("/sandbox init")
            assert any(n["notifyType"] == "error" for n in notifications)
            assert config_path.read_text() == original

            for _ in range(2):
                client.command("/sandbox add readonly /opt/my  tools")
            assert json.loads(config_path.read_text())["filesystem"]["readonlyPaths"] == ["/opt/my  tools"]
            client.command("/sandbox remove readonly /opt/my  tools")
            assert json.loads(config_path.read_text())["filesystem"]["readonlyPaths"] == []

            client.command("/sandbox network allow")
            network = json.loads(config_path.read_text())["network"]
            assert network == {"egress": "allow", "ingress": "deny", "hostLoopback": "deny"}
            client.command("/sandbox network deny")

            response, _ = client.request({"type": "bash", "command": "printf 'rpc-sandbox-ok'"})
            assert response["success"] and response["data"]["output"] == "rpc-sandbox-ok", response
            response, _ = client.request({"type": "bash", "command": "printf 'escape' > ../escape.txt"})
            assert response["success"] and response["data"]["exitCode"] != 0, response
            assert not (directory / "escape.txt").exists()

            client.command("/sandbox off")
            assert json.loads(config_path.read_text())["enabled"] is False
            response, _ = client.request({"type": "bash", "command": "printf 'local' > ../local.txt"})
            assert response["success"] and response["data"]["exitCode"] == 0, response
            assert (directory / "local.txt").read_text() == "local"
            client.command("/sandbox on")

            original = config_path.read_text()
            client.command("/sandbox edit", cancel_editor=True)
            assert config_path.read_text() == original
            notifications = client.command("/sandbox edit", editor_response="{")
            assert any(n["notifyType"] == "error" for n in notifications)
            assert config_path.read_text() == original

            config_path.write_text("{")
            response, _ = client.request({"type": "bash", "command": "printf 'bypass' > ../bypass.txt"})
            assert not response["success"], response
            assert not (directory / "bypass.txt").exists()
            client.command("/sandbox edit", editor_response=original)
            assert json.loads(config_path.read_text())["enabled"] is True

            notifications = client.command("/sandbox path")
            assert any(n["message"] == str(config_path) for n in notifications)
            print("RPC verified: extension loading, config commands, editor validation and cancellation,")
            print("native user bash, explicit local opt-out, and fail-closed malformed config.")
        finally:
            client.close()


if __name__ == "__main__":
    main()
