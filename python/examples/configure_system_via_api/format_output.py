from datetime import datetime
import logging


def format_output_string(setting, value):
    shift_pos = 28
    format_string = "* " + setting.ljust(shift_pos) + ": " + value + "\n"
    return format_string

def create_output_string(result):
    output_string = ""
    output_string += format_output_string("System Name",result["system_name"])
    output_string += format_output_string("Connect to Cloud",result["connect_to_cloud"])
    output_string += format_output_string("Auto Discovery", result["auto_discovery"])
    output_string += format_output_string("Anonymous Statistics Report",result["anonymous_statistics_report"])
    output_string += format_output_string("Camera Optimization",result["camera_optimization"])
    return output_string

def output_to_file(file_content,system_name,timestamp):
    output_file_path = f"{system_name}_{timestamp}_configure_result.log"
    try:
        with open(output_file_path,'w') as file:
            file.write(file_content)
    except IOError as e:
        print(f"[ERROR] Summary report can't be generated.Path:{output_file_path}")
        logging.error(f"Summary report can't be generated.Path:{output_file_path}")
        logging.error(e)