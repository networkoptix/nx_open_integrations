#!/usr/bin/env python3
import argparse
import requests
import sys
import pathlib
sys.path += [f'{pathlib.Path(__file__).parent.resolve()}/../../common']
import server_api as api
from dataclasses import dataclass, field
from urllib.parse import quote
import json

# Define a dataclass for the command line arguments
@dataclass
class CommandLineArgs:
    parent_cp_id: str = ""
    target: str = ""
    username: str = ""
    password: str = ""
    operation: str = ""
    op_target_id: str = ""
    custom_id: str = ""          # This will hold CUSTOM_ID
    new_custom_id: str = ""      # This will hold NEW_CUSTOM_ID (for edit only)

#CLOUD_USER = ""  # cloud account
#CLOUD_PASSWORD = ""  # cloud account password
CLOUD_DOMAIN_NAME = 'meta.nxvms.com'  # Cloud service domain name
CLOUD_URL = 'https://' + CLOUD_DOMAIN_NAME  # Cloud portal URL
SAAS_PARTNER_API_ENDPOINT="https://meta.nxvms.com/partners/api/v2"

# Function to get Bearer Token
def get_bearer_token(username, password):
    oauth_payload = api.create_cloud_auth_payload(username,password)
    oauth_response = api.request_api(
        CLOUD_URL,
        f'/cdb/oauth2/token',
        'POST',
        json=oauth_payload)
    
    return api.get_token(oauth_response)

# Construct the appropriate URI based on the targer
def uri_factory(target, parent_cp_id, operation, custom_id=None):
    if operation == "add" or ( operation == "list" and custom_id is None):
        uri = f"/{target}s/{parent_cp_id}/external_ids/"
    else:
        custom_id_encoded = quote(custom_id)
        uri = f"/{target}s/{parent_cp_id}/external_ids/{custom_id_encoded}/"
    return uri

def create_json_payload(target, op_target_id, custom_id):
    json_payload = {}
    if target == "channel_partner":
        json_payload = {"customId": custom_id, "channelPartner": op_target_id}
    elif target == "cloud_system":
        json_payload = {"customId": custom_id,  "cloudSystemId":op_target_id}
    elif target == "organization":
        json_payload = {"customId": custom_id, "organization": op_target_id}
    elif target == "service":
        json_payload = {"customId": custom_id, "channelPartnerService": op_target_id}
    else:
        print("Invalid endpoint")
        sys.exit(1)
    return json_payload

# Function to manipulate custom_id based on the action (add, delete, edit, list)
def manipulate_custom_id(bearer_token:str, operation:str, parent_cp_id:str, target, op_target_id:str, custom_id:str, new_custom_id=""):
    headers = api.create_auth_header(bearer_token)
    uri = uri_factory(target, parent_cp_id, operation, custom_id)
    if operation == "add":
        json_payload = create_json_payload(target, op_target_id, custom_id)
        response = api.request_api(SAAS_PARTNER_API_ENDPOINT, uri, "POST", headers=headers, json=json_payload)
    elif operation == "delete":
        response = api.request_api(SAAS_PARTNER_API_ENDPOINT, uri, "DELETE", headers=headers)
    elif operation == "edit":
        json_payload = create_json_payload(target, op_target_id, new_custom_id)
        response = api.request_api(SAAS_PARTNER_API_ENDPOINT, uri, "PATCH", headers=headers, json=json_payload)
    elif operation == "list":
        response = api.request_api(SAAS_PARTNER_API_ENDPOINT, uri, "GET", headers=headers)
    else:
        print("Invalid action")
        sys.exit(1)

    if isinstance(response, bytes):
        response = {"result": "custome_id is deleted successfully"}
    
    print(json.dumps(response, indent=4))

def main():
    parser = argparse.ArgumentParser(description="Command line tool to manipulate custom ids for channel partners.")
    
    # Positional arguments for instance, username, password, entity_type, and action
    parser.add_argument('parent_cp_id', help="The channel_partner ID which your entities belongs to")
    parser.add_argument('operation', help="Operation to perform (add, edit, delete, list)", choices=['add', 'edit', 'delete','list'])
    parser.add_argument('target', help="The type of target to manipulate", choices=['channel_partner', 'organization', 'cloud_system', 'service'])
    
    
    # Optional arguments for op_target_id,custom_id and new_custom_id (for edit)
    parser.add_argument('op_target_id', nargs='?', help="The operation target ID")
    parser.add_argument('custom_id', nargs='?', help="The custome_id for add, edit, or list")
    parser.add_argument('new_custom_id', nargs='?', help="New Custom ID for replacing the previous one")

    #Authentication
    parser.add_argument('-u', '--username', help="Your username for authentication")
    parser.add_argument('-p', '--password', help="Your password for authentication")

    args = parser.parse_args()

    # Create CommandLineArgs dataclass instance with the parsed arguments
    cli_args = CommandLineArgs(
        target=args.target,
        parent_cp_id=args.parent_cp_id,
        username=args.username,
        password=args.password,
        operation=args.operation,
        op_target_id=args.op_target_id,
        custom_id=args.custom_id,
        new_custom_id=args.new_custom_id
    )

    # Determine operation type
    if cli_args.operation is None:
        print("Please specify the desired operation.")
        sys.exit(1)

    # Handle validations for required custom_ids
    if cli_args.operation == "add" and not cli_args.custom_id:
        print("Error: CUSTOM_ID is required for add action")
        sys.exit(1)
    if cli_args.operation == "edit" and (not cli_args.custom_id or not cli_args.new_custom_id):
        print("Error: Both OLD_CUSTOM_ID and NEW_CUSTOM_ID are required for edit action")
        sys.exit(1)
    if cli_args.operation == "delete" and not cli_args.custom_id:
        print("Error: CUSTOM_ID is required for delete action")
        sys.exit(1)
    
    #Handle list operation specifically (No custom_id, list all. With custom_id, show the specified one)
    if cli_args.operation == "list" and cli_args.op_target_id and not cli_args.custom_id:
        cli_args.custom_id = args.op_target_id
        cli_args.op_target_id = None

    # Get the Bearer Token
    bearer_token = get_bearer_token(cli_args.username, cli_args.password)
    # Execute Operation
    manipulate_custom_id(bearer_token, cli_args.operation, cli_args.parent_cp_id, cli_args.target, cli_args.op_target_id, cli_args.custom_id, cli_args.new_custom_id)
    
if __name__ == "__main__":
    main()