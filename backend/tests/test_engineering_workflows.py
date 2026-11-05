"""Offline acceptance fixtures: real coordinator and executor, two scripted transports."""
import asyncio
import re
from pathlib import Path

import httpx
import pytest

from app.capabilities.models.router import set_provider_override
from app.capabilities.models import opencode_turn as adapter
from app.capabilities.models import opencode
from app.capabilities.skills.contracts import workflow_spec
from conftest import NativeScriptedProvider, agent, events, make_company, start_run, wait_status


BEFORE = "VALUE = 1\n"
AFTER = "VALUE = 2\n"
CHECK = (
    "import unittest\nfrom pathlib import Path\n"
    "class ResultTest(unittest.TestCase):\n"
    "    def test_result(self):\n"
    "        self.assertEqual(Path('app.py').read_text(), 'VALUE = 2\\n')\n"
)


class WorkflowProgram:
    def __init__(self, workflow, *, omit_proof=False, variant=""):
        self.workflow = workflow
        self.omit_proof = omit_proof
        self.variant = variant
        self.ids = {}
        self.previous_tool = None
        self.steps = list(self.actions())
        self.position = 0

    def checkpoint(self, step, output_key, output, references=()):
        return "record_checkpoint", {"step": step, "outputs": {output_key: output}, "_refs": references}

    def actions(self):
        if self.workflow in ("explain", "review"):
            yield "read_file", {"path": "app.py"}
            yield self.checkpoint("inspect", "source_references", "app.py:1 defines VALUE = 1", ("read_file",))
            if self.workflow == "explain":
                yield self.checkpoint("answer", "answer", "VALUE is the integer 1.", ("read_file",))
            else:
                yield self.checkpoint("review", "review_report", "Scoped review: app.py:1 defines the expected integer; no issue in this fixture.", ("read_file",))
        else:
            yield "read_file", {"path": "test_check.py"}
            if self.variant == "out_of_order":
                yield self.checkpoint("implement", "change_manifest", "Attempting to skip acceptance and design", ("read_file",))
                yield "finish", {"summary": "Skipped prerequisite checkpoints"}
                return
            if self.workflow == "fix":
                command = "python -m unittest discover" if self.variant == "wrong_reproduction_command" else "python -m unittest test_check"
                yield "run_code", {"command": command, "covered_paths": ["app.py", "test_check.py"], "criterion_ids": ["requested_outcome"]}
                yield self.checkpoint("reproduce", "reproduction", "Observed test_result fail: VALUE was 1, expected 2", ("run_code",))
            else:
                yield self.checkpoint("acceptance", "acceptance_criteria", "python -m unittest test_check passes when app.py contains VALUE = 2", ("read_file",))
                yield self.checkpoint("design", "design", "Own app.py; use the existing unittest acceptance check", ("read_file",))
            yield "write_file", {"path": "app.py", "content": AFTER}
            yield self.checkpoint("implement", "change_manifest", "app.py now defines VALUE = 2", ("write_file",))
            if not self.omit_proof:
                yield "run_code", {"command": "python -m unittest test_check", "covered_paths": ["app.py", "test_check.py"], "criterion_ids": ["requested_outcome"]}
                yield self.checkpoint("verify", "verification", "Observed test_result pass on current app.py", ("run_code",))
        yield "finish", {"summary": f"{self.workflow} fixture complete"}

    def next(self, output=""):
        if self.previous_tool:
            matches = re.findall(r"Observed tool_call_ids:\s*([^\]\n]+)", output)
            if matches:
                self.ids[self.previous_tool] = [item.strip() for item in matches[-1].split(",") if item.strip()]
        if self.position >= len(self.steps):
            return "wait", {}
        tool, args = self.steps[self.position]
        self.position += 1
        args = dict(args)
        refs = args.pop("_refs", None)
        if refs is not None:
            args["tool_call_ids"] = [cid for ref in refs for cid in self.ids.get(ref, [])]
        self.previous_tool = tool
        return tool, args


class ScriptedACPSession:
    """Model replacement only: every requested action goes over the actual loopback MCP bridge."""
    program = None
    instances = []

    def __init__(self, root, update, permission):
        self.root, self.update, self.permission = root, update, permission
        self.session_id = ""
        self.cancelled = asyncio.Event()
        self.instances.append(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        pass

    async def open(self, previous, model, effort, plan, *, mcp_servers=None, agent=None):
        self.session_id = "workflow-fixture"
        self.server = mcp_servers[0]

    async def send(self, message):
        if message.get("method") == "session/cancel":
            self.cancelled.set()

    async def prompt(self, blocks):
        headers = {item["name"]: item["value"] for item in self.server["headers"]}
        output = ""
        async with httpx.AsyncClient() as client:
            for index in range(30):
                tool, arguments = self.program.next(output)
                response = await client.post(self.server["url"], headers=headers, json={"jsonrpc": "2.0", "id": index,
                    "method": "tools/call", "params": {"name": tool, "arguments": arguments}})
                result = response.json()["result"]
                assert not result["isError"], result
                output = "\n".join(item["text"] for item in result["content"])
                if "This invocation has ended." in output:
                    await asyncio.wait_for(self.cancelled.wait(), 3)
                    return {"stopReason": "cancelled"}
        raise AssertionError("Fixture exhausted tool limit")


async def run_fixture(client, workspace, monkeypatch, workflow, transport, *, omit_proof=False, variant=""):
    root = Path(workspace["path"])
    if workflow != "build":
        (root / "app.py").write_text(BEFORE, encoding="utf-8")
    if workflow in ("fix", "build"):
        (root / "test_check.py").write_text(CHECK, encoding="utf-8")
    program = WorkflowProgram(workflow, omit_proof=omit_proof, variant=variant)
    lead = agent("lead", "Lead", entry=True, tools={"terminal": True, "file_read": True, "file_write": True})
    if transport == "native":
        def round_(context, outputs):
            return [program.next(outputs[-1] if outputs else "")]
        set_provider_override(NativeScriptedProvider({"Lead": [round_] * 25}))
    else:
        lead.update(provider="opencode", model="test/model")
        ScriptedACPSession.program = program
        ScriptedACPSession.instances = []
        monkeypatch.setattr(adapter, "OpenCodeSession", ScriptedACPSession)
        async def discover():
            return opencode.OpenCodeStatus(available=True, executable="scripted-no-model", models=["test/model"])
        monkeypatch.setattr(opencode, "discover", discover)
    company = await make_company(client, workspace, [lead], [])
    run = await start_run(client, workspace, company, goal={
        "explain": "Explain the value defined in app.py", "fix": "Fix app.py so the existing unittest passes",
        "build": "Build app.py to satisfy the existing unittest", "review": "Review app.py without changing it"}[workflow],
        permission_level="danger", budget={"engineering_workflow": workflow, "verify_before_finish": True,
                                           "independent_review": False, "max_tool_rounds": 32, "max_turns": 8})
    final = await wait_status(client, workspace, run["id"], timeout=25)
    return root, final, await events(client, workspace, run["id"])


@pytest.mark.parametrize("transport", ["native", "acp"])
@pytest.mark.parametrize("workflow", ["explain", "fix", "build", "review"])
async def test_four_workflows_use_real_executor_and_current_evidence(client, workspace, monkeypatch, workflow, transport):
    root, final, log = await run_fixture(client, workspace, monkeypatch, workflow, transport)
    assert final["status"] == "completed", (final["halt_reason"], final["state"].get("engineering_blockers"),
        [(event["type"], event["payload"]) for event in log if event["type"] in ("tool_result", "error")])
    state = final["state"]
    assert state["engineering_workflow"] == workflow
    assert state["lead_agent_id"] == "lead"
    assert not state["engineering_blockers"]
    checkpoints = {item["step"]: item for item in state["engineering_checkpoints"]}
    assert set(checkpoints) == {step.key for step in workflow_spec(workflow).steps}
    assert all(item["owner"] == "lead" and item["revision"] == state["plan_revision"] for item in checkpoints.values())
    assert checkpoints[next(iter(checkpoints))]["tool_call_ids"]
    if workflow in ("fix", "build"):
        assert (root / "app.py").read_text() == AFTER
        evidence = [item for item in state["execution_evidence"] if item["status"] == "pass"]
        assert evidence and evidence[-1]["criterion_ids"] == ["requested_outcome"]
        assert checkpoints["verify"]["tool_call_ids"] == [evidence[-1]["check"]["tool_call_id"]]
        if workflow == "fix":
            assert any(event["type"] == "tool_result" and event["payload"]["tool"] == "run_code" and not event["payload"]["ok"] for event in log)
    else:
        assert (root / "app.py").read_text() == BEFORE
    if transport == "acp":
        assert state["worker_sessions"]["lead"]["session_id"] == "workflow-fixture"


@pytest.mark.parametrize("transport", ["native", "acp"])
@pytest.mark.parametrize("workflow", ["fix", "build"])
async def test_changed_artifact_without_observed_proof_cannot_complete(client, workspace, monkeypatch, workflow, transport):
    _, final, _ = await run_fixture(client, workspace, monkeypatch, workflow, transport, omit_proof=True)
    assert final["status"] == "incomplete"
    assert final["state"]["engineering_blockers"]
    assert not any(item["status"] == "pass" for item in final["state"]["execution_evidence"])


@pytest.mark.parametrize("transport", ["native", "acp"])
async def test_out_of_order_checkpoint_cannot_skip_prerequisites(client, workspace, monkeypatch, transport):
    root, final, log = await run_fixture(client, workspace, monkeypatch, "build", transport, variant="out_of_order")
    assert final["status"] == "incomplete"
    assert not final["state"]["engineering_checkpoints"]
    assert not (root / "app.py").exists()
    assert any(event["type"] == "tool_result" and "Earlier checkpoints are missing" in event["payload"].get("output", "") for event in log)


@pytest.mark.parametrize("transport", ["native", "acp"])
async def test_fix_requires_successful_replay_of_original_reproduction(client, workspace, monkeypatch, transport):
    root, final, _ = await run_fixture(client, workspace, monkeypatch, "fix", transport, variant="wrong_reproduction_command")
    assert (root / "app.py").read_text() == AFTER
    assert final["status"] == "incomplete"
    assert "reproduction command was not repeated" in " ".join(final["state"]["engineering_blockers"])
