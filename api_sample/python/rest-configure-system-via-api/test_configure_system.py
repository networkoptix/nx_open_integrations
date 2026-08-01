# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Offline tests for configure_system.py. No network, no server needed.

main() is tested with vms_system.VmsSystem replaced by a fake, so nothing
here ever constructs a real VmsSystem or touches the network -- that's
already covered by test_vms_system.py.

Run from this folder:  pytest -v
"""

import pytest

import configure_system as sample
import vms_system


# ---------------------------------------------------------------------------
# get_args()
# ---------------------------------------------------------------------------

def test_get_args_defaults():
    args = sample.get_args([])
    assert args.file == "system_setting.conf"
    assert args.output is False
    assert args.silent is False


def test_get_args_file_long_flag():
    args = sample.get_args(["--file", "my_system.conf"])
    assert args.file == "my_system.conf"


def test_get_args_file_short_flag():
    args = sample.get_args(["-f", "my_system.conf"])
    assert args.file == "my_system.conf"


def test_get_args_output_flag():
    args = sample.get_args(["-o"])
    assert args.output is True


def test_get_args_silent_flag():
    args = sample.get_args(["--silent"])
    assert args.silent is True


def test_get_args_all_flags_together():
    args = sample.get_args(["-f", "custom.conf", "-o", "-s"])
    assert args.file == "custom.conf"
    assert args.output is True
    assert args.silent is True


# ---------------------------------------------------------------------------
# main()
# ---------------------------------------------------------------------------

class FakeVmsSystem:
    """Stands in for vms_system.VmsSystem so main() never touches the network."""

    result = {
        "system_name": "TestSystem",
        "connect_to_cloud": "CONNECTED",
        "auto_discovery": "ENABLED",
        "anonymous_statistics_report": "ENABLED",
        "camera_optimization": "ENABLED",
    }

    def __init__(self, configuration_file):
        self.configuration_file = configuration_file

    def setup_system(self):
        return self.result


class RaisingVmsSystem:
    """Stands in for a VmsSystem whose construction or setup fails."""

    def __init__(self, configuration_file):
        raise RuntimeError("could not read configuration")


def test_main_success_prints_summary(monkeypatch, tmp_path, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(vms_system, "VmsSystem", FakeVmsSystem)

    exit_code = sample.main(["-f", "system_setting.conf"])

    assert exit_code == 0
    out = capsys.readouterr().out
    assert "TestSystem" in out
    assert "CONNECTED" in out


def test_main_silent_suppresses_terminal_output(monkeypatch, tmp_path, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(vms_system, "VmsSystem", FakeVmsSystem)

    exit_code = sample.main(["-s"])

    assert exit_code == 0
    assert capsys.readouterr().out == ""


def test_main_output_writes_result_file(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(vms_system, "VmsSystem", FakeVmsSystem)

    exit_code = sample.main(["-o", "-s"])

    assert exit_code == 0
    result_files = list(tmp_path.glob("TestSystem_*_configure_result.log"))
    assert len(result_files) == 1
    assert "TestSystem" in result_files[0].read_text()


def test_main_failure_returns_error_code(monkeypatch, tmp_path, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(vms_system, "VmsSystem", RaisingVmsSystem)

    exit_code = sample.main([])

    assert exit_code == 1
    out = capsys.readouterr().out
    assert "[ERROR]" in out


def test_main_defaults_to_sys_argv(monkeypatch, tmp_path, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(vms_system, "VmsSystem", FakeVmsSystem)
    monkeypatch.setattr("sys.argv", ["configure_system.py", "-s"])

    exit_code = sample.main()

    assert exit_code == 0
    assert capsys.readouterr().out == ""
