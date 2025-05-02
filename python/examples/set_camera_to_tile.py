#!/usr/bin/env python3

## Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

import argparse
import uuid
import common.server_api as api


def tile_id_to_pos(layout, tile_id):
    w = max(layout['fixedWidth'], 1)
    h = layout['fixedHeight']
    left = int(w / 2) * -1
    top = int(h / 2) * -1

    x = tile_id % w
    y = int(tile_id / w)
    return (x + left, y + top)


def get_layout(session, id, verbose):
    if verbose:
        print("Looking for layout {}".format(id))
    return session.get(f'/rest/v3/layouts/{id}')


def add_camera_to_layout(layout, camera_id, tile_id, verbose):
    tile_pos = tile_id_to_pos(layout, tile_id)
    for item in layout['items']:
        item_pos = (item['left'], item['top'])
        if item_pos == tile_pos:
            if verbose:
                print("Updating existing item")
            item['resourceId'] = ''  # Existing id must be cleaned
            item['resourcePath'] = str(camera_id)
            item['id'] = str(uuid.uuid4())
            return layout

    if verbose:
        print("Adding new item")
    layout['items'].append(
        {
            'id': str(uuid.uuid4()),
            'left': tile_pos[0],
            'top': tile_pos[1],
            'right': tile_pos[0] + 1,
            'bottom': tile_pos[1] + 1,
            'flags': 1,
            'resourcePath': str(camera_id)
        }
    )
    return layout


def save_layout(session, id, layout, verbose):
    if verbose:
        print("Saving layout...")
    session.put(f'/rest/v3/layouts/{id}', json=layout)


def set_camera_to_tile(session, camera_id, screen_id, tile_id, verbose):
    layout = get_layout(session, screen_id, verbose)
    if not layout:
        print("Layout {} not found".format(screen_id))
        return

    layout = add_camera_to_layout(layout, camera_id, tile_id, verbose)
    save_layout(session, screen_id, layout, verbose)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('-c', '--camera', help="Camera id", required=True, type=int)
    parser.add_argument('-s', '--screen', help="Screen logical id", required=True, type=int)
    parser.add_argument('-t', '--tile', help="Tile id", required=True, type=int)
    parser.add_argument('-v', '--verbose', action='store_true', help="verbose output")
    api.Session.add_arguments(parser)
    args = parser.parse_args()
    session = api.Session.from_args(args)

    try:
        return set_camera_to_tile(
            session,
            camera_id=args.camera,
            screen_id=args.screen,
            tile_id=args.tile,
            verbose=args.verbose)
    except api.Session.RequestException as e:
        print(e)

if __name__ == "__main__":
    main()
