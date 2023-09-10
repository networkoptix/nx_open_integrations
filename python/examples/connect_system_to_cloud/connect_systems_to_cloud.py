#!/usr/bin/python3
import logging
import argparse
import requests
import sys
import urllib3
import json
import csv
import system

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
logging.basicConfig(filename="connect_to_cloud.log",
                    filemode='a',
                    format='%(asctime)s %(levelname)s %(message)s',
                    datefmt="%Y-%m-%d %H:%M:%S",
                    level=logging.INFO)
logger = logging.getLogger(__name__)

def get_args(argv):
    parser = argparse.ArgumentParser("connect_to_cloud.py",formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("-f", "--file", action='store', default="system.csv",
                        help="Specify the file to read system list")  
    data = parser.parse_args(argv)
    return data

if __name__ == "__main__":
    cmd_args = get_args(sys.argv[1:])
    input_file_csv = cmd_args.file
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
                    system_entry["enable_auto_discovery"]
                )
                system_to_be_setup.setup_system()
    except IOError:
        print("Error: File specified seems not appear to exist. Path:{path}".format(path=input_file_csv))
        logging.critical("Error: System list can't be opened/found. Path:{path}".format(path=input_file_csv))