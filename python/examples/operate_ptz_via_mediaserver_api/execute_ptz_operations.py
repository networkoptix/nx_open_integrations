#!/usr/bin/env python3
"""
Copyright © 2018–present Network Optix, Inc.  
Licensed under [MPL 2.0](https://www.mozilla.org/MPL/2.0/)

PTZ Control CLI Tool

Provides command-line access to PTZ functions:
- Continuous move
- Stop move
- Absolute move
- Presets (get/set/goto)
- Tours (get/activate/stop)

"""

from dataclasses import dataclass
import sys
import pathlib
import argparse
import json
import uuid

# Add common path for server_api
sys.path.append(f"{pathlib.Path(__file__).parent.resolve()}/../common")
import server_api as api
from camera import Camera


API_VERSION = "v3"
CLOUD_PORTAL = "https://meta.nxvms.com"


@dataclass
class Site:
    """Configuration object holding site information."""
    url: str
    cloud_system_id: str
    username: str
    password: str
    port: int


def parse_args():
    """Parse and return command-line arguments."""
    parser = argparse.ArgumentParser(description="PTZ Control Command Line Tool")

    parser.add_argument("--url", help="Server IP or URL")
    parser.add_argument("--cloud_system_id", help="Cloud System ID")
    parser.add_argument("--port", type=int, default=7001, help="Server port")
    parser.add_argument("--username", required=True, help="Username")
    parser.add_argument("--password", required=True, help="Password")
    parser.add_argument("--camera", required=True, help="Camera ID")

    parser.add_argument(
        "--ptz",
        required=True,
        choices=[
            "move", "stop", "abs_move",
            "get_presets", "set_preset", "go_preset",
            "get_tours", "activate_tour", "stop_tour",
        ],
        help="PTZ operation type",
    )

    parser.add_argument("--pan", type=float, default=0.0, help="Pan value (-1.0 to 1.0)")
    parser.add_argument("--tilt", type=float, default=0.0, help="Tilt value (-1.0 to 1.0)")
    parser.add_argument("--zoom", type=float, default=0.0, help="Zoom value (-1.0 to 1.0)")
    parser.add_argument("--speed", type=float, default=0.5, help="Speed (0.0 to 1.0)")
    parser.add_argument("--id", type=str, help="Preset ID or Tour ID")
    parser.add_argument("--preset_name", type=str, help="Preset Name")

    return parser.parse_args()


def login(site: Site):
    """
    Authenticate to the server and return authorization headers.
    Uses cloud authentication if cloud_system_id is provided,
    otherwise falls back to local authentication.
    """
    if site.cloud_system_id:  # Cloud auth
        auth_payload = api.create_cloud_auth_payload(site.username, site.password, site.cloud_system_id)
        response = api.request_api(
            CLOUD_PORTAL,
            '/cdb/oauth2/token',
            'POST',
            json=auth_payload,
            verify=False,
            allow_redirects=False,
        )
        token = api.get_token(response)
    else:  # Local auth
        server_url = f"https://{site.url}:{site.port}"
        auth_payload = api.create_auth_payload(site.username, site.password)
        response = api.request_api(
            server_url,
            f'/rest/{API_VERSION}/login/sessions',
            'POST',
            json=auth_payload,
            verify=False,
            allow_redirects=False,
        )
        token = api.get_local_ms_token(response)

    return api.create_auth_header(token)


def create_ptz_request_body(args):
    """Generate request body depending on the PTZ command."""
    request_body = {}
    match args.ptz:
        case "move":
            request_body = {
                "api":"operational",
                "pan": args.pan, 
                "tilt": args.tilt, 
                "zoom": args.zoom, 
                "speed": args.speed
            }
        case "abs_move":
            request_body = {
                "type": "absolute", 
                "api": "operational",
                "pan": args.pan, 
                "tilt": args.tilt, 
                "zoom": args.zoom, 
                "speed": args.speed
            }
        case "set_preset":            
            request_body = {
                "id": str(uuid.uuid4()), 
                "name": args.preset_name if args.preset_name else f"Preset_{args.pan}_{args.tilt}_{args.zoom}"
            }
        case "go_preset":
            request_body = {
                "speed": args.speed
            }
        case _:
            request_body = {}

    return request_body


def main():
    args = parse_args()
    site = Site(args.url, args.cloud_system_id, args.username, args.password, args.port)

    # Build server URL depending on whether cloud or local
    server_url = (
        f"https://{site.cloud_system_id}.relay.vmsproxy.com"
        if site.cloud_system_id else f"https://{site.url}:{site.port}"
    )

    # Authenticate and get headers
    auth_header = login(site)

    # Get camera info
    camera_info = api.request_api(
        server_url,
        f'/rest/{API_VERSION}/devices/{args.camera}',
        'GET',
        headers=auth_header,
        verify=False,
        allow_redirects=False,
    )

    if 'error' in camera_info:
        print(f"Error retrieving camera info: {camera_info['error']['message']}")
        sys.exit(1)

    camera = Camera(camera_info)
    request_body = create_ptz_request_body(args)

    # Dispatch PTZ operations
    print(f"Executing PTZ command: {args.ptz}...")

    match args.ptz:
        case "move":
            camera.ptz_move_start(server_url, args.camera, auth_header, request_body)
        case "stop":
            camera.ptz_move_stop(server_url, args.camera, auth_header)
        case "abs_move":
            camera.ptz_move_absolute(server_url, args.camera, auth_header, request_body)
        case "get_presets":
            print(json.dumps(camera.ptz_get_presets(server_url, args.camera, auth_header), indent=4))
        case "set_preset":
            camera.ptz_set_preset(server_url, args.camera, auth_header, request_body)
        case "go_preset":
            camera.ptz_goto_preset(server_url, args.camera, auth_header, args.id, request_body)
        case "get_tours":
            print(json.dumps(camera.ptz_get_tours(server_url, args.camera, auth_header), indent=4))
        case "activate_tour":
            camera.ptz_activate_tour(server_url, args.camera, args.id, auth_header)
        case "stop_tour":
            camera.ptz_stop_tour(server_url, args.camera, auth_header, request_body)
        case _:
            print("Unknown PTZ command.")


if __name__ == "__main__":
    main()