#!/usr/bin/env python3
# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Entry point for the "configure a system" sample.

Reads a system_setting.conf-style INI file (see system_setting.conf and the
README), drives VmsSystem.setup_system() to apply it against one VMS server,
and prints/saves a summary. All the request logic lives in vms_system.py;
this file is just the CLI wrapper around it.
"""

from datetime import datetime
import logging
import argparse
import sys

import vms_system
import format_output

logging.basicConfig(filename="configure_system.log",
                    filemode='a',
                    format='%(asctime)s %(levelname)s %(message)s',
                    datefmt="%Y-%m-%d %H:%M:%S",
                    level=logging.INFO)
logger = logging.getLogger(__name__)


def get_args(argv):
    parser = argparse.ArgumentParser("configure_system.py",
                                     formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("-f", "--file", action='store', default="system_setting.conf",
                        help="Specify the file to read system settings from")
    parser.add_argument("-o", "--output", action='store_true', default=False,
                        help="Specify if the summary result will be stored in a file")
    parser.add_argument("-s", "--silent", action='store_true', default=False,
                        help="Silent mode. The result will not be displayed on terminal.")
    return parser.parse_args(argv)


def main(argv=None):
    """Run the sample. Returns a process exit code (0 success, 1 failure)."""
    cmd_args = get_args(argv if argv is not None else sys.argv[1:])
    logger.debug(f"cmd_arg = {cmd_args}")

    start_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    string_for_output = "====================\n"
    string_for_output += format_output.format_output_string("Start Time", start_time)

    try:
        vms = vms_system.VmsSystem(cmd_args.file)
        result = vms.setup_system()
    except Exception as e:
        print("[ERROR] Configuration result is not available.")
        print("[ERROR] Result summary has not been generated.")
        logger.error("Can't start the application, force quit")
        logger.error(e)
        return 1

    string_for_output += format_output.create_output_string(result)
    string_for_output += format_output.format_output_string(
        "Finish Time", datetime.now().strftime('%Y-%m-%d %H:%M:%S'))

    if cmd_args.output:
        format_output.output_to_file(string_for_output, result["system_name"], start_time)
    if not cmd_args.silent:
        print(string_for_output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
