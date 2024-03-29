const DOORS_LIST = [
    {
        "server": "Walnut Creek",
        "doors": [
            {
                "name": "WC - Building Entry/Parking",
                "cameras": [
                    "9ce4fe89-57ec-3254-1d76-65e0ee26c808",
                    "ff0049d6-f86a-2c72-7bb4-68d636de4551",
                    "175099cd-826e-f0be-169c-5a37ba57cfc6",
                    "9044626e-9ef4-4394-785c-66c9569c9a5c"
                ]
            },
            {
                "name": "WC - Front Door",
                "cameras": [
                    "62f711ed-e26d-e3dc-4ea0-a378ca0ecc26",
                    "90553aac-05dd-a3c1-d76c-2986b8e34c3b", // has something in the view that keeps triggering motion probably
                    "9044626e-9ef4-4394-785c-66c9569c9a5c" // duplicate of building entry 4th
                ]
            },
            {
                "name": "WC - Stairs",
                "cameras": [
                    "3c2cbdd6-7e6c-14be-f093-140e79979160",
                    "1020806b-e210-9ffa-6fe1-51e30b20e03f",
                    "1020806b-e210-9ffa-6fe1-51e30b20e03f" // duplicate above
                ]
            },
            {
                "name": "WC - IDF/SERVER",
                "cameras": [
                    "a4413776-217c-a65f-e4de-2a8354fec64a", // in a folder
                    "5bfd7271-1a20-2e04-ce48-877bc544f43f"
                ]
            },
            {
                "name": "WC - Hallway door",
                "cameras": [
                    "3c2cbdd6-7e6c-14be-f093-140e79979160", // duplicate
                    "1020806b-e210-9ffa-6fe1-51e30b20e03f" // duplicate
                ]
            }
        ]
    },
    {
        "server": "Burbank",
        "doors": [
            {
                "name": "LA - Double door main entry",
                "cameras": [
                    "2968dd29-93ab-1c26-c117-6fe6ae42ebd8", // erroring
                    "2f8480a3-100e-f444-c493-69e960772db0", // other door video, but also erroring
                    "8bbd4c7d-49b8-3950-6371-d726882adf86" // should be server room, part of a group
                ]
            },
            {
                "name": "LA - IDF/SERVER",
                "cameras": [
                    "6a5f7d8a-aba6-b6f5-404e-2bb3f84dec35",
                    "0e7bd3da-46e0-4472-c72b-f9ddbc9e6508",
                    "4c3926e2-c23f-7dcb-aa2b-817a35c0a1f2" // should be main entry by elevator
                ]
            },
            {
                "name": "LA - Main entry by elevator ",
                "cameras": [
                    "61f69e67-04ec-20a5-1894-a64091db98e3",
                    "a1cc65a5-5e3d-48c5-897c-dc8f621a8d2a",
                    "26ecce2a-b573-9a01-967d-c2cccbfe4629"
                ]
            }
        ]
    },
    {
        "server": "Demo Server",
        "doors": [
            {
                "name": "Demo Reader",
                "cameras": [
                    "aa877c68-b2e4-bd1a-cc81-255e0b34af60",
                    "0690778c-4e7f-9cb2-cbd6-70b140d9806e"
                ]
            }
        ]
    }
]