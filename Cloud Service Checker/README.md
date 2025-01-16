# Cloud Service Checker

**Cloud Service Checker** is a Python script that verifies the availability of cloud service URLs, including mediators, traffic relays, speed test servers, and time servers. It supports optional IP resolution and saving results to a CSV file.

---

## Features

- Fetches URLs dynamically from provided JSON endpoints.
- Checks URL availability and connectivity for specific ports.
- Optional IP resolution for detailed results.
- Saves results to a CSV file for easy sharing and analysis.

---

## Prerequisites

### 1. Supported Operating Systems
- **Windows**
- **Ubuntu Linux**
- **macOS**

### 2. Python Version
- **Python 3.7** or newer is required.

---

## Installation

### Step 1: Clone or Download the Repository
Download the script to your local system.

```bash
git clone https://github.com/your-repo/cloud-service-checker.git
cd cloud-service-checker
```

### Step 2: Install Required Packages
The script uses the following Python packages:
- `requests` (for fetching JSON data)
- `csv` (built-in module for saving results)

To install the required package, run:
```bash
pip install requests
```

or create venv and install requests there
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install requests
```

or create venv and install requirements.txt there
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Step 3: Additional Dependencies (Windows Only)
On Windows, you may need to ensure that the `socket` module works properly by keeping your Python environment updated:
- Use the official Python installer from [python.org](https://www.python.org/downloads/).

---

## Usage

Run the script using Python 3:

```bash
python3 CloudServiceChecker.py
```

### Options
1. **IP Resolution**:
   - When prompted, select `Y` to resolve IP addresses or `N` to skip IP resolution.

2. **Saving Results**:
   - At the end of the run, you can save the results as a CSV file by selecting `Y` when prompted.

---

## Notes for Specific Operating Systems

### **Windows**
- Ensure Python is added to your `PATH` environment variable.
- Run the script using the `python` or `python3` command in the Command Prompt or PowerShell.

### **Ubuntu Linux**
- Install Python and `pip` if not already installed:
  ```bash
  sudo apt update
  sudo apt install python3 python3-pip
  ```
- Run the script using `python3`.

### **macOS**
- Install Python 3 using Homebrew or the Python installer:
  ```bash
  brew install python
  ```

---

## Example Output

### Terminal Output
```plaintext
Cloud Service Checker starting...

Checking Mediator URLs:
https://ap-southeast-2.mediator.vmsproxy.com:3345 Available
https://eu-central-1.mediator.vmsproxy.com:3345 Unavailable

Checking Traffic Relay URLs:
https://relay-chi.vmsproxy.com:80 Available
https://relay-fr.vmsproxy.com:80 Available
Etc.
```

### CSV Output
```csv
Category,URL,Port,IP (Resolved),Status
Mediator URLs,https://ap-southeast-2.mediator.vmsproxy.com,3345,52.95.99.12,Available
Mediator URLs,https://eu-central-1.mediator.vmsproxy.com,3345,,Unavailable
Traffic Relay URLs,https://relay-chi.vmsproxy.com,80,,Available
Traffic Relay URLs,https://relay-fr.vmsproxy.com,80,,Available
Etc.
```

---

## Contributions
Feel free to submit issues or pull requests to improve the script.

---

## License
Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

---

