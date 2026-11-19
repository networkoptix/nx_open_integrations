#!/usr/bin/env python3

## Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

"""Download and unpack the VMS Server Plugin SDK from meta.nxvms.com.

The SDK is called "Metadata SDK" up to 6.0 and "Server Plugin SDK" since 6.1; the layout is the
same. Prints the unpacked SDK directory, to be passed to the plugins as -DnxSdkDir=<dir>.

Examples:
    download_sdk.py                 # latest release
    download_sdk.py 6.1.3           # 6.1.3 (latest build of it)
    download_sdk.py 6.0.6.41837 -o ~/nx_sdk
    download_sdk.py --list
"""

import argparse
import json
import ssl
import subprocess
import sys
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

RELEASES_URL = "https://meta.nxvms.com/api/utils/downloads/history"
SDK_APP_TYPES = ("server_plugin_sdk", "metadata_sdk")


def fetch(url):
    """Return the contents of url."""
    try:
        with urllib.request.urlopen(url, timeout=60) as response:
            return response.read()
    except urllib.error.URLError as e:
        if sys.platform != "win32" or not isinstance(e.reason, ssl.SSLCertVerificationError):
            raise
    # On Windows, Python trusts only the root certificates already in the Windows certificate
    # store, while Windows adds the missing ones when its own HTTPS client first needs them. So
    # download with curl.exe (part of Windows 10+), which uses that client.
    print("Python cannot verify the certificate; retrying with curl.exe", file=sys.stderr)
    return subprocess.run(["curl.exe", "--fail", "--location", "--silent", "--show-error", url],
        stdout=subprocess.PIPE, check=True).stdout


def sdk_releases():
    """Yield (version, url) for each release that has an SDK, newest first."""
    data = json.loads(fetch(RELEASES_URL))
    for release in data["releases"]:
        sdk = next((f for f in release["installers"] if f["appType"] in SDK_APP_TYPES), None)
        if sdk:
            yield release["version"], f"{data['updatesPrefix']}/{release['buildNumber']}/{sdk['path']}"


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("version", nargs="?", help="e.g. 6.1.3 or 6.1.3.43301 (default: latest)")
    parser.add_argument("-o", "--output-dir", type=Path, default=Path("sdk"),
        help="where to unpack; each version goes to its own subdirectory (default: ./sdk)")
    parser.add_argument("--list", action="store_true", help="list available versions and exit")
    args = parser.parse_args()

    releases = list(sdk_releases())
    if args.list:
        for version, _ in releases:
            print(version)
        return

    matches = [
        (version, url) for version, url in releases
        if not args.version or version == args.version or version.startswith(args.version + ".")
    ]
    if not matches:
        sys.exit(f"No SDK found for version {args.version}; see --list.")
    version, url = matches[0]

    target_dir = args.output_dir.expanduser().resolve() / version.replace(" ", "_")
    sdk_dirs = [d for d in target_dir.glob("*") if (d / "src" / "nx" / "sdk").is_dir()]
    if not sdk_dirs:
        target_dir.mkdir(parents=True, exist_ok=True)
        zip_path = target_dir / url.rsplit("/", 1)[1]
        print(f"Downloading {url}", file=sys.stderr)
        zip_path.write_bytes(fetch(url))
        with zipfile.ZipFile(zip_path) as archive:
            archive.extractall(target_dir)
        zip_path.unlink()
        sdk_dirs = [d for d in target_dir.glob("*") if (d / "src" / "nx" / "sdk").is_dir()]
        if not sdk_dirs:
            sys.exit(f"Unexpected archive layout in {url}: no */src/nx/sdk directory.")

    print(sdk_dirs[0])


if __name__ == "__main__":
    main()
