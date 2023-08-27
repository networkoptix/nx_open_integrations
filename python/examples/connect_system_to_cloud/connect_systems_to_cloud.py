#!/usr/bin/python3
import logging
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
    description = """Helper script for setting up servers.
    Usage:
    \t ./setup_system address "ports" - Sets up the mediaservers without connnecting to cloud
    \t ./setup_system address "ports" -e user@networkoptix.com -p credentials
    """
    parser = argparse.ArgumentParser("setup_system", description=description,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("address", help="IP address of the host system.")
    parser.add_argument("ports", help="Ports of the host system.")
    parser.add_argument("system_password", help="Password for the servers.")

    parser.add_argument("-c", "--cloud", action='store_true',
                        help="Connect system to cloud after setup.")
    parser.add_argument("-d", "--disable-autodiscover", action='store_true',
                        help="Disables auto discover.")
    parser.add_argument("-i", "--instance", nargs="?", default=False,
                        help="Target cloud instance.")
    parser.add_argument("-e", "--email", nargs="?", default="",
                        help="Email for the cloud account.")
    parser.add_argument("-p", "--password", nargs="?", default="",
                        help="Password for the cloud account.")

    data = parser.parse_args(argv)

    if data.cloud:
        assert data.instance and data.email and data.password

    return data


if __name__ == "__main__":

    systemlistFile = "systems.csv"
    # Retrieve the systems that needs to be handled.
    systems_list = []

    try:
        with open(systemlistFile, newline='') as csvfile:
            systems = csv.DictReader(csvfile)
            for system_entry in systems:
                #system_entry.
                '''
                systems_list.append(system.system(
                    system_entry["ip_address"],
                    system_entry["port"],
                    system_entry["system_name"],
                    system_entry["local_admin_password"],
                    system_entry["cloud_host"],
                    system_entry["cloud_account"],
                    system_entry["cloud_password"]
                ))
                '''
                local_sys = system.system(
                    system_entry["ip_address"],
                    system_entry["port"],
                    system_entry["system_name"],
                    system_entry["local_admin_password"],
                    system_entry["cloud_host"],
                    system_entry["cloud_account"],
                    system_entry["cloud_password"]
                )
                with requests.Session() as s:
                    local_sys.connect_to_cloud(s)
                    s.close
            
    except IOError:
        print ("Erro: The list of the transferred systems : '{path}' does not appear to exist.".format(path=systemlistFile))
        logging.critical("Error: System list does not appear to exist. Path:{path}".format(path=systemlistFile))