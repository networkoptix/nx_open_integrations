#!/usr/bin/python3
from datetime import datetime
import logging
import argparse
import requests
import sys
import urllib3
import json
import csv
import system

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
logging.basicConfig(filename="system_setup.log",
                    filemode='a',
                    format='%(asctime)s %(levelname)s %(message)s',
                    datefmt="%Y-%m-%d %H:%M:%S",
                    level=logging.INFO)
logger = logging.getLogger(__name__)

SHIFT_POS = 30
CONNECT_CLOUD_OK_STR = "* Connect to Cloud".ljust(SHIFT_POS) + ": CONNECTED\n"
CONNECT_CLOUD_FAIL_STR = "* Connect to Cloud".ljust(SHIFT_POS) + ": DISCONNECTED(LOCAL)\n"
AUTO_DISCOVERY_OK_STR = "* Auto Discovery".ljust(SHIFT_POS) + ": ENABLED\n"
AUTO_DISCOVERY_FAIL_STR = "* Auto Discovery".ljust(SHIFT_POS) + ": DISABLED\n"
ANONYMOUS_STASTICS_REPORT_OK_STR = "* Anonymous Statistics Report".ljust(SHIFT_POS) + ": ENABLED\n"
ANONYMOUS_STASTICS_REPORT_FAIL_STR = "* Anonymous Statistics Report".ljust(SHIFT_POS) + ": DISABLED\n"
CAMERA_OPTIMIZATION_OK_STR = "* Camera Optimization".ljust(SHIFT_POS) + ": ENABLED\n"
CAMERA_OPTIMIZATION_FAIL_STR = "* Camera Optimization".ljust(SHIFT_POS) + ": DISABLED\n"
TIMESTAMP_STR =f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
OUTPUT_FILE_PATH = f"{TIMESTAMP_STR}_result_summary.log"

def get_timestamp_str(stage):
    return_str = ""
    if stage == "start":
        return_str = "* Start at".ljust(SHIFT_POS) + ": " + TIMESTAMP_STR + "\n"
    else:
        return_str = "* Finish at".ljust(SHIFT_POS) + ": " + TIMESTAMP_STR + "\n"
    return return_str 

def get_args(argv):
    parser = argparse.ArgumentParser("connect_to_cloud.py",formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("-f", "--file", action='store', default="systems.csv",
                        help="Specify the file to read system list")
    parser.add_argument("-o", "--output", action='store_true', default=False,
                        help="Specify if the summary result will be stored in a file")
    parser.add_argument("-p", "--print", action='store_true', default=True,
                        help="Display the result on terminal.")
    data = parser.parse_args(argv)
    return data

def create_output_str(output_str, result):
    output_str = "====================\n"
    output_str += get_timestamp_str("start")
    output_str += "* System Name".ljust(SHIFT_POS) + f': {result["system_name"]}\n'
    
    if result["connect_to_cloud"]:
        output_str += CONNECT_CLOUD_OK_STR
    else:
        output_str += CONNECT_CLOUD_FAIL_STR

    if result["auto_discovery"]:
        output_str += AUTO_DISCOVERY_OK_STR
    else:
        output_str += AUTO_DISCOVERY_FAIL_STR
    
    if result["anonymous_statistics_report"]:
        output_str += ANONYMOUS_STASTICS_REPORT_OK_STR
    else:
        output_str += ANONYMOUS_STASTICS_REPORT_FAIL_STR
    
    if result["camera_optimization"]:
        output_str += CAMERA_OPTIMIZATION_OK_STR
    else:
        output_str += CAMERA_OPTIMIZATION_FAIL_STR

    output_str += get_timestamp_str("finish")
    return output_str


def output_to_file(str_to_file):
    try:
        with open(OUTPUT_FILE_PATH,'w') as file:
            file.write(str_to_file)

    except IOError as e:
        print("Error: Summary report can't be generated.Path:{path}".format(path=OUTPUT_FILE_PATH))
        logging.error("Error: Summary report can't be generated.Path:{path}".format(path=OUTPUT_FILE_PATH))
        logging.error(e)

if __name__ == "__main__":
    cmd_args = get_args(sys.argv[1:])
    input_file_csv = cmd_args.file
    is_output_to_file_required = cmd_args.output
    is_display_on_terminal = cmd_args.print
    str_for_output = ""

    try:
        with open(input_file_csv, newline='') as system_list:
            systems = csv.DictReader(system_list)
            for system_entry in systems:
                system_to_be_setup = system.system(
                    system_entry["ip_address"],
                    system_entry["port"],
                    system_entry["system_name"],
                    system_entry["local_admin_password"],
                    system_entry["cloud_host"],
                    system_entry["cloud_account"],
                    system_entry["cloud_password"],
                    system_entry["connect_to_cloud"],
                    system_entry["enable_auto_discovery"],
                    system_entry["allow_anonymous_statistics_report"],
                    system_entry["enable_camera_optimization"]
                )
                result = system_to_be_setup.setup_system()
                str_for_output += create_output_str(str_for_output, result)

        if is_output_to_file_required:
            output_to_file(str_for_output)
        if is_display_on_terminal:
            print(str_for_output)  

    except IOError:
        print("Error: Input file specified seems not appear to exist. Path:{path}".format(path=input_file_csv))
        logging.error("System list can't be opened/found. Path:{path}".format(path=input_file_csv))