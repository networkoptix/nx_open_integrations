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
TIMESTAMP_STR =f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
OUTPUT_FILE_PATH = f"{TIMESTAMP_STR}_result_summary.log"

def get_args(argv):
    parser = argparse.ArgumentParser("connect_to_cloud.py",formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("-f", "--file", action='store', default="systems.csv",
                        help="Specify the file to read system list")
    parser.add_argument("-o", "--output", action='store_true', default=False,
                        help="Specify if the summary result will be stored in a file")
    parser.add_argument("-p", "--print", action='store_true', default=False,
                        help="Display the result on terminal.")
    data = parser.parse_args(argv)
    return data

def format_output_string(setting, value):
    shift_pos = 28
    format_string = "* " + setting.ljust(shift_pos) + ": " + value + "\n"
    return format_string

def create_output_str(output_str, result, state):
    output_str = "====================\n"
    output_str += format_output_string("Start Time",TIMESTAMP_STR)
    if state:
        output_str += format_output_string("System Name",result["system_name"])
        output_str += format_output_string("Connect to Cloud",result["connect_to_cloud"])
        output_str += format_output_string("Auto Discovery", result["auto_discovery"])
        output_str += format_output_string("Anonymous Statistics Report",result["anonymous_statistics_report"])
        output_str += format_output_string("Camera Optimization",result["camera_optimization"])
    else:
        err_str = f'{system_entry["system_name"]} = Openration Failed, NOT successfully done.'
        output_str += format_output_string("System Name",err_str)
    output_str += format_output_string("Finish Time",TIMESTAMP_STR)
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
                try:
                    result = system_to_be_setup.setup_system()
                    str_for_output += create_output_str(str_for_output, result, True)
                    if is_output_to_file_required:
                        output_to_file(str_for_output)
                    if is_display_on_terminal:
                        print(str_for_output)  
                except :
                    print(f'Openration Failed : The operation to {system_entry["system_name"]} is not successfully done.')
                    logging.error(f'Openration Failed : The operation to {system_entry["system_name"]} is not successfully done.')
                    str_for_output += create_output_str(str_for_output, result, False)
                    if is_output_to_file_required:
                        output_to_file(str_for_output)
                    if is_display_on_terminal:
                        print(str_for_output) 
                    continue            
    except :
        print("Error: Input file specified seems not appear to exist. Path:{path}".format(path=input_file_csv))
        logging.error("System list can't be opened/found. Path:{path}".format(path=input_file_csv))