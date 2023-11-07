#!/usr/bin/python3
from datetime import datetime
import logging
import argparse
import sys
import vms_system

logging.basicConfig(filename="configure_system.log",
                    filemode='a',
                    format='%(asctime)s %(levelname)s %(message)s',
                    datefmt="%Y-%m-%d %H:%M:%S",
                    level=logging.INFO)
logger = logging.getLogger(__name__)
timestamp = f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"

def get_args(argv):
    parser = argparse.ArgumentParser("configure_system.py",formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("-f", "--file", action='store', default="system_settings.conf",
                        help="Specify the file to read system settings")
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

def create_output_string(output_string, result, state):
    output_string = "====================\n"
    output_string += format_output_string("Start Time",timestamp)
    if state:
        output_string += format_output_string("System Name",result["system_name"])
        output_string += format_output_string("Connect to Cloud",result["connect_to_cloud"])
        output_string += format_output_string("Auto Discovery", result["auto_discovery"])
        output_string += format_output_string("Anonymous Statistics Report",result["anonymous_statistics_report"])
        output_string += format_output_string("Camera Optimization",result["camera_optimization"])
    else:
        err_string = f'{server_config["server"]["system_name"]} = Openration Failed, NOT successfully done.'
        output_string += format_output_string("System Name",err_string)
    output_string += format_output_string("Finish Time",timestamp)
    return output_string

def output_to_file(file_content,system_name):
    output_file_path = f"{system_name}_{timestamp}_configure_result.log"
    try:
        with open(output_file_path,'w') as file:
            file.write(file_content)
    except IOError as e:
        print("Error: Summary report can't be generated.Path:{path}".format(path=output_file_path))
        logging.error("Error: Summary report can't be generated.Path:{path}".format(path=output_file_path))
        logging.error(e)

if __name__ == "__main__":
    cmd_args = get_args(sys.argv[1:])
    is_output_to_file_required = cmd_args.output
    is_display_on_terminal = cmd_args.print
    string_for_output = ""
    
    try:
        vms = vms_system.VmsSystem(cmd_args.file)
        result = vms.setup_system()
        string_for_output += create_output_string(string_for_output, result, True)
        if is_output_to_file_required:
            output_to_file(string_for_output,result["system_name"])
        if is_display_on_terminal:
            print(string_for_output)
    except Exception as e:
        logging.error(e)
        print("[ERROR] Configuration result is not available. The operation is not successfully done.")
        print("[ERROR] Result summary has not been generated.")
