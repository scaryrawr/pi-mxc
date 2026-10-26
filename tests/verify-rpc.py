"""Exercise the installed pi CLI and /sandbox commands without model calls."""

import argparse
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


def effective_policy(client):
    notifications = client.command("/sandbox status")
    status = next(n["message"] for n in notifications if "Effective policy:\n" in n["message"])
    return json.loads(status.split("Effective policy:\n", 1)[1])


def main(commands_only=False):
    with tempfile.TemporaryDirectory(prefix="pi-mxc-rpc-") as temporary:
        directory = Path(temporary)
        config_path = directory / "agent" / "pi-mxc.json"
        client = Rpc(directory)
        try:
            response, _ = client.request({"type": "get_commands"})
            assert any(c["name"] == "sandbox" for c in response["data"]["commands"]), response
            assert not config_path.exists(), "Loading the extension wrote the config"

            client.command("/sandbox off")
            assert effective_policy(client)["enabled"] is False
            assert not config_path.exists(), "Session changes wrote a config"
            client.command("/sandbox reset")

            client.command("/sandbox init")
            initial = json.loads(config_path.read_text())
            assert initial["enabled"] is True
            default_readonly = initial["filesystem"]["readonlyPaths"]
            assert default_readonly[0] == "~/.gitconfig" and len(default_readonly) == 4, initial
            original = config_path.read_text()
            notifications = client.command("/sandbox init")
            assert any(n["notifyType"] == "error" for n in notifications)
            assert config_path.read_text() == original

            for _ in range(2):
                client.command("/sandbox add readonly /opt/my  tools")
            assert effective_policy(client)["filesystem"]["readonlyPaths"] == default_readonly + ["/opt/my  tools"]
            assert config_path.read_text() == original, "Session grant changed saved defaults"
            client.command("/sandbox remove readonly /opt/my  tools")
            assert effective_policy(client)["filesystem"]["readonlyPaths"] == default_readonly

            client.command("/sandbox add readonly relative-tools")
            assert str((directory / "workspace" / "relative-tools").resolve()) in effective_policy(client)["filesystem"]["readonlyPaths"]
            client.command("/sandbox remove readonly relative-tools")
            assert effective_policy(client)["filesystem"]["readonlyPaths"] == default_readonly

            client.command("/sandbox add readwrite /session-only-access")
            client.command("/sandbox --persist add readonly /saved-access")
            saved = json.loads(config_path.read_text())
            assert saved["filesystem"]["readonlyPaths"] == default_readonly + ["/saved-access"]
            assert saved["filesystem"]["readwritePaths"] == ["."]
            assert "/session-only-access" in effective_policy(client)["filesystem"]["readwritePaths"]
            client.command("/sandbox reset")
            assert effective_policy(client) == saved
            client.command("/sandbox --persist remove readonly /saved-access")

            client.command("/sandbox network allow")
            assert effective_policy(client)["network"] == {"egress": "allow", "ingress": "deny", "hostLoopback": "deny"}
            assert json.loads(config_path.read_text())["network"]["egress"] == "deny"
            client.command("/sandbox reset")
            client.command("/sandbox --persist network allow")
            assert json.loads(config_path.read_text())["network"]["egress"] == "allow"
            client.command("/sandbox --persist network deny")

            client.command("/sandbox off")
            assert effective_policy(client)["enabled"] is False
            assert json.loads(config_path.read_text())["enabled"] is True
            response, _ = client.request({"type": "bash", "command": "printf 'session-local-ok'"})
            assert response["success"] and response["data"]["output"] == "session-local-ok", response
            response, _ = client.request({"type": "new_session"})
            assert response["success"], response
            assert effective_policy(client)["enabled"] is True, "Session overrides leaked across a session switch"

            client.command("/sandbox --persist off")
            assert json.loads(config_path.read_text())["enabled"] is False
            client.command("/sandbox --persist on")

            if not commands_only:
                response, _ = client.request({"type": "bash", "command": "printf 'rpc-sandbox-ok'"})
                assert response["success"] and response["data"]["output"] == "rpc-sandbox-ok", response
                response, _ = client.request({"type": "bash", "command": "printf 'escape' > ../escape.txt"})
                assert response["success"] and response["data"]["exitCode"] != 0, response
                assert not (directory / "escape.txt").exists()

                client.command("/sandbox off")
                response, _ = client.request({"type": "bash", "command": "printf 'local' > ../local.txt"})
                assert response["success"] and response["data"]["exitCode"] == 0, response
                assert (directory / "local.txt").read_text() == "local"
                client.command("/sandbox reset")

            original = config_path.read_text()
            client.command("/sandbox edit", cancel_editor=True)
            assert config_path.read_text() == original
            notifications = client.command("/sandbox edit", editor_response="{")
            assert any(n["notifyType"] == "error" for n in notifications)
            assert config_path.read_text() == original

            edited = json.loads(original)
            edited["filesystem"]["readonlyPaths"].append("/editor-session-access")
            client.command("/sandbox edit", editor_response=json.dumps(edited))
            assert "/editor-session-access" in effective_policy(client)["filesystem"]["readonlyPaths"]
            assert config_path.read_text() == original
            edited["inheritHostPath"] = False
            client.command("/sandbox edit", editor_response=json.dumps(edited))
            assert effective_policy(client)["inheritHostPath"] is False
            del edited["inheritHostPath"]
            client.command("/sandbox edit", editor_response=json.dumps(edited))
            assert "inheritHostPath" not in effective_policy(client), "Omitting an optional field did not restore its default"
            client.command("/sandbox reset")

            client.command("/sandbox off")
            config_path.write_text("{")
            response, _ = client.request({"type": "bash", "command": "printf 'bypass' > ../bypass.txt"})
            assert not response["success"], response
            assert not (directory / "bypass.txt").exists()
            client.command("/sandbox --persist edit", editor_response=original)
            assert json.loads(config_path.read_text())["enabled"] is True
            assert effective_policy(client)["enabled"] is False, "Saving defaults silently replaced a session override"
            client.command("/sandbox reset")
            assert effective_policy(client)["enabled"] is True

            notifications = client.command("/sandbox path")
            assert any(n["message"] == str(config_path) for n in notifications)
            print("RPC verified: session-only policy, explicit persistence, session-switch reset,")
            print("editor validation and cancellation, isolated defaults, and fail-closed malformed config.")
            print("Native bash checks skipped (--commands-only)." if commands_only else "Native bash and explicit local opt-out verified.")
        finally:
            client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--commands-only", action="store_true", help="Verify command behavior without launching native sandboxes")
    main(commands_only=parser.parse_args().commands_only)
