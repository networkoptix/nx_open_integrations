#!/usr/bin/env python3

## Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

import argparse
import pprint
from time import sleep

import common.server_api as api

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        '--period',
        type=int, default=60,
        help="Send periodically every value of seconds")
    parser.add_argument(
        '--count',
        type=int, default=1,
        help="Number of requests to send")
    parser.add_argument(
        '--source',
        type=str, default="Source",
        help="Event source")
    parser.add_argument(
        '--caption',
        type=str, default="Caption",
        help="Event caption")
    parser.add_argument(
        '--description',
        type=str, default="Description",
        help="Event description")
    parser.add_argument(
        '--resource',
        type=str,
        help="Resource ID which will be passed explicitly")
    parser.add_argument(
        '--refs',
        nargs='*',
        type=str,
        help="Camera refs which will be passed as metadata")
    api.Session.add_arguments(parser)

    args = parser.parse_args()

    session = api.Session.from_args(args)
    for i in range(args.count):
        try:
            payload = {
                "source": args.source,
                "caption": args.caption,
                "description": args.description
            }
            if args.resource:
                payload["eventResourceId"] = args.resource
            if args.refs:
                payload["metadata"] = {
                    "cameraRefs": args.refs
                }
            print(f"Send event {i} with payload\n{pprint.pformat(payload)}")
            session.post('/api/createEvent', json=payload)
            print("Event sent successfully")
        except api.Session.RequestException as e:
            print(e)
        if i < args.count - 1:
            sleep(args.period)


if __name__ == '__main__':
    main()
