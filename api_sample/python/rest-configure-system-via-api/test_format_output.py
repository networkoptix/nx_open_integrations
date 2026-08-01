# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Offline tests for format_output.py. No network, no server needed.

Run from this folder:  pytest -v
"""

import pytest

import format_output as sample


# ---------------------------------------------------------------------------
# format_output_string
# ---------------------------------------------------------------------------

def test_format_output_string_pads_the_label():
    line = sample.format_output_string("System Name", "MySystem")
    assert line == "* System Name" + " " * (28 - len("System Name")) + ": MySystem\n"


def test_format_output_string_label_longer_than_shift_pos():
    # ljust is a no-op once the label is already longer than shift_pos.
    long_label = "A" * 40
    line = sample.format_output_string(long_label, "value")
    assert line == f"* {long_label}: value\n"


# ---------------------------------------------------------------------------
# create_output_string
# ---------------------------------------------------------------------------

def test_create_output_string_includes_all_fields_in_order():
    result = {
        "system_name": "MySystem",
        "connect_to_cloud": "CONNECTED",
        "auto_discovery": "ENABLED",
        "anonymous_statistics_report": "DISABLED",
        "camera_optimization": "ENABLED",
    }
    output = sample.create_output_string(result)

    lines = output.strip("\n").split("\n")
    assert len(lines) == 5
    assert "System Name" in lines[0] and "MySystem" in lines[0]
    assert "Connect to Cloud" in lines[1] and "CONNECTED" in lines[1]
    assert "Auto Discovery" in lines[2] and "ENABLED" in lines[2]
    assert "Anonymous Statistics Report" in lines[3] and "DISABLED" in lines[3]
    assert "Camera Optimization" in lines[4] and "ENABLED" in lines[4]


def test_create_output_string_missing_key_raises_keyerror():
    with pytest.raises(KeyError):
        sample.create_output_string({"system_name": "MySystem"})


# ---------------------------------------------------------------------------
# output_to_file
# ---------------------------------------------------------------------------

def test_output_to_file_writes_content(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    sample.output_to_file("hello world\n", "MySystem", "2026-07-31 10:00:00")

    written = tmp_path / "MySystem_2026-07-31 10:00:00_configure_result.log"
    assert written.exists()
    assert written.read_text() == "hello world\n"


def test_output_to_file_ioerror_is_swallowed(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    def raise_ioerror(*args, **kwargs):
        raise IOError("disk full")

    monkeypatch.setattr("builtins.open", raise_ioerror)

    # Should not raise -- the function logs/prints and returns.
    sample.output_to_file("hello world\n", "MySystem", "2026-07-31 10:00:00")

    captured = capsys.readouterr()
    assert "[ERROR]" in captured.out
