#!/usr/bin/python3
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
    data = parser.parse_args(argv)
    return data

if __name__ == "__main__":
    cmd_args = get_args(sys.argv[1:])
    logging.debug(f"cmd_arg = {cmd_args}")
    start_time = f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
    string_for_output = "====================\n"
    string_for_output += format_output.format_output_string("Start Time",start_time)
    try:
        vms = vms_system.VmsSystem(cmd_args.file)
        result = vms.setup_system()
    except Exception as e:
        print("[ERROR] Configuration result is not available.")
        print("[ERROR] Result summary has not been generated.")
        logging.error("Can't start the application, force quit")
        logging.error(e)
        sys.exit(1)
    string_for_output += format_output.create_output_string(result)
    string_for_output += format_output.format_output_string("Finish Time",
                                                f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    ###
    if cmd_args.output:
        format_output.output_to_file(string_for_output,result["system_name"],start_time)
    if not cmd_args.silent:
        print(string_for_output)