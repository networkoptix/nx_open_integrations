## Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

import socket
from time import sleep, time as current_time
import requests
import csv

# Prompt user if they want to resolve IP addresses
while True:
    resolve_ip_input = input("\nDo you want to resolve IP addresses? (Y/N): ").strip().lower()
    if resolve_ip_input in ["y", "yes"]:
        resolve_ip = True
        break
    elif resolve_ip_input in ["n", "no"]:
        resolve_ip = False
        break
    else:
        print("Invalid input. Please enter Y or N.")

print("\nCloud Service Checker starting...\n")

# Pause for 2 seconds
sleep(2)

def save_to_csv(output_rows):
    """
    Save the results to a CSV file.

    Args:
        output_rows (list): A list of rows to write into the CSV file. Each row is a list of values.

    Returns:
        None
    """
    filename = f"CloudServiceCheckerResults_{int(current_time())}.csv"
    with open(filename, 'w', newline='') as csvfile:
        writer = csv.writer(csvfile)
        writer.writerow(["Category", "URL", "Port", "IP (Resolved)", "Status"])
        writer.writerows(output_rows)
    print(f"Output saved to {filename}")

class bcolors:
    """
    A utility class for adding color to terminal output.

    Attributes:
        OK (str): Green color for successful messages.
        FAIL (str): Red color for failure messages.
        WARNING (str): Yellow color for warning messages.
        ENDC (str): Reset color to default.
    """
    OK = '\033[92m'
    FAIL = '\033[91m'
    WARNING = '\033[93m'
    ENDC = '\033[0m'

def isOpen(ip, port):
    """
    Check if a TCP port is open on the given IP address.

    Args:
        ip (str): IP address of the server.
        port (int): TCP port number.

    Returns:
        bool: True if the port is open, False otherwise.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(1)
    try:
        s.connect((ip, int(port)))
        s.shutdown(2)
        return True
    except:
        return False

def resolve_ip_address(ip):
    """
    Resolve a hostname to its IP address.

    Args:
        ip (str): The hostname to resolve.

    Returns:
        str: The resolved IP address, or None if resolution fails.
    """
    try:
        return socket.gethostbyname(ip)
    except socket.gaierror:
        return None

def fetch_urls(json_url):
    """
    Fetch a list of URLs from a JSON file hosted on the web.

    Args:
        json_url (str): URL to the JSON file.

    Returns:
        list: A list of URLs extracted from the JSON file. Returns an empty list if the fetch fails.
    """
    try:
        # Fetch URLs silently
        response = requests.get(json_url)
        if response.status_code == 200:
            data = response.json()
            return [entry["url"] for entry in data]
        else:
            return []
    except Exception:
        return []

# Fetch URLs for traffic relays and mediators from updated JSON files
traffic_relay_json_url = "https://prod-relays-and-mediators.s3.us-east-1.amazonaws.com/traffic_relays.json"
mediator_json_url = "https://prod-relays-and-mediators.s3.us-east-1.amazonaws.com/connection_mediators.json"

traffic_relay_urls = fetch_urls(traffic_relay_json_url)
mediator_urls = fetch_urls(mediator_json_url)

# Ports
mediator_port = 3345
h_ports = [80, 443]  # Ports for traffic relays

output_rows = []  # Output rows for CSV
closed_flag = False

# Default values for retries and timeout
retries = 3
timeout = 1

# Function to check a list of URLs for single or multiple ports
def check_urls(urls, ports, category):
    """
    Check the availability of a list of URLs for the specified ports.

    Args:
        urls (list): A list of URLs to check.
        ports (int | list): A single port or a list of ports to check for each URL.
        category (str): The category of the URLs being checked (e.g., "Mediator URLs").

    Returns:
        None
    """
    global closed_flag, output_rows
    print(f"\nChecking {category}:\n")
    if not urls:
        print(f"No URLs to check for {category}.")
        return
    
    # Ensure ports is always a list
    if isinstance(ports, int):
        ports = [ports]
    
    for url in urls:
        print(f"Processing URL: {url}")
        ip = None
        resolved_ip = ""  # Empty column for CSV if IP resolution is disabled
        if resolve_ip:
            ip = resolve_ip_address(url.replace("https://", "").replace("http://", ""))
            resolved_ip = ip if ip else ""

        # Check each port
        for port in ports:
            # Retry logic using only the URL (domain name)
            for i in range(retries):
                if isOpen(url.replace("https://", "").replace("http://", ""), port):
                    # Successful connection
                    if resolve_ip and resolved_ip:
                        print(bcolors.OK + f"{url}:{port} ({resolved_ip}) Available" + bcolors.ENDC)
                    else:
                        print(bcolors.OK + f"{url}:{port} Available" + bcolors.ENDC)
                    output_rows.append([category, url, port, resolved_ip, "Available"])
                    break
                else:
                    # Failed attempt
                    if i < retries - 1:
                        if resolve_ip and resolved_ip:
                            print(bcolors.WARNING + f"{url}:{port} ({resolved_ip}) connection retry in 1 second" + bcolors.ENDC)
                        else:
                            print(bcolors.WARNING + f"{url}:{port} connection retry in 1 second" + bcolors.ENDC)
                        sleep(1)
                    else:
                        # Final failure
                        if resolve_ip and resolved_ip:
                            print(bcolors.FAIL + f"{url}:{port} ({resolved_ip}) Unavailable" + bcolors.ENDC)
                        else:
                            print(bcolors.FAIL + f"{url}:{port} Unavailable" + bcolors.ENDC)
                        output_rows.append([category, url, port, resolved_ip, "Unavailable"])
                        closed_flag = True

# Sort URLs alphabetically before checking
mediator_urls = sorted(mediator_urls) if mediator_urls else []
traffic_relay_urls = sorted(traffic_relay_urls) if traffic_relay_urls else []
fetching_services_urls = sorted([
    'tools.vmsproxy.com',
    'tools-eu.vmsproxy.com',
    'licensing.vmsproxy.com',
	'updates.vmsproxy.com',
	'beta.vmsproxy.com',
	'stats.vmsproxy.com',
	'stats2.vmsproxy.com'
])
speedtest_urls = sorted(['speedtest.vmsproxy.com'])
time_urls = sorted([
    'time.rfc868server.com',
    'us-west.rfc868server.com',
    'frankfurt.rfc868server.com',
    'singapore.rfc868server.com'
])

# Check mediator URLs first
if mediator_urls:
    check_urls(mediator_urls, mediator_port, category="Mediator URLs")
else:
    print("Skipping Mediator URLs check: No URLs fetched.")

# Check traffic relay URLs second
if traffic_relay_urls:
    check_urls(traffic_relay_urls, h_ports, category="Traffic Relay URLs")
else:
    print("Skipping Traffic Relay URLs check: No URLs fetched.")

# Check hardcoded fetching_services, speedtest and time URLs last
check_urls(fetching_services_urls, h_ports, category="Fetching Services URLs")
check_urls(speedtest_urls, 80, category="Speedtest URLs")
check_urls(time_urls, 37, category="Time Server URLs")

# Display final message
if closed_flag:
    print("\nNot all cloud nodes are accessible from your device at the moment.")
    print("We recommend verifying the status of our cloud service through the following link:")
    print("\nhttps://networkoptix.atlassian.net/wiki/spaces/CHS/overview")
    print("\nIf there are no reported incidents on our cloud status page,")
    print("we recommend investigating your local network configuration, firewall settings,")
    print("and other related factors to ensure that all FQDN addresses are reachable.")
    print("\nIn case of any issues and questions, please share the output with our support team.")
else:
    print("\nWe're pleased to inform you that all cloud nodes are accessible from this device.")
    print("\nIn case of any issues and questions, please share the output with our support team.")

# Prompt the user to save the output
while output_rows:
    save_option = input("Do you want to save the output to a CSV file? (Y/N): ").strip().lower()
    if save_option in ['y', 'yes']:
        save_to_csv(output_rows)
        break
    elif save_option in ['n', 'no']:
        print("Output not saved.")
        break
    else:
        print("Invalid input. Please enter Y or N.")
