"""Safety and report parsing checks for local diagnostic scripts."""
import json
from pathlib import Path

import pytest


@pytest.mark.asyncio
async def test_doctor_only_discovers_and_handshakes_in_disposable_directory(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2]))
    from scripts import runtime_doctor as doctor
    from app.plugins.providers.opencode import OpenCodeProbe

    calls = []
    directories = []
    monkeypatch.setattr(doctor, "executable", lambda: ["existing-opencode.exe"])

    async def command(argv, cwd, timeout=20):
        assert cwd.is_dir()
        calls.append(argv)
        directories.append(cwd)
        return {"exit_code": 0, "output": "v1" if argv[-1] == "--version" else "provider/model\nnot a model\n"}

    async def handshake(cwd):
        assert cwd == directories[0]
        assert not list(cwd.iterdir())
        return OpenCodeProbe(available=True, protocol_version=1,
            config_options=[{"id": "model", "name": "Model", "type": "select", "currentValue": "private-value"}])

    monkeypatch.setattr(doctor, "inspect_command", command)
    monkeypatch.setattr(doctor, "probe", handshake)
    report = await doctor.collect()
    assert calls == [["existing-opencode.exe", "--version"], ["existing-opencode.exe", "models"]]
    assert report["policy"]["model_prompts"] == 0
    assert report["temporary_directory_cleaned"]
    assert report["opencode"]["model_discovery"]["models"] == ["provider/model"]
    assert "private-value" not in json.dumps(report)
    assert not directories[0].exists()


@pytest.mark.asyncio
async def test_missing_cli_is_a_report_not_an_install_attempt(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2]))
    from scripts import runtime_doctor as doctor

    def missing():
        raise FileNotFoundError("Existing installation missing")

    monkeypatch.setattr(doctor, "executable", missing)
    result = await doctor.collect()
    assert not result["opencode"]["available"]
    assert not result["policy"]["downloads"]
    assert result["policy"]["model_prompts"] == 0


def test_evaluation_counts_errors_and_skips_without_calling_them_passes(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2]))
    from scripts.evaluate_runtime import junit_counts

    xml = tmp_path / "result.xml"
    xml.write_text('<testsuites><testsuite tests="6" failures="1" errors="1" skipped="2" /></testsuites>')
    assert junit_counts(xml) == {"tests": 6, "failures": 1, "errors": 1, "skipped": 2, "passed": 2}
    assert junit_counts(tmp_path / "missing.xml")["passed"] == 0
