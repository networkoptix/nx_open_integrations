// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/ 


## Abstract ##

Starting from the build 28389 (~ 4.0 beta-2), the Nx Server allows its debian package to be 
installed directly from a Dockerfile (lower versions are incompatible).  Without systemd
in the container the server may not handle crashes or restarts properly.  It is recommended
to run containers with --restart options.

## Restrictions ##

*  Only Debian Linux container is supported.
*  Linux hosts are supported.
*  MacOS hosts can be used but with limitations.
*  Windows hosts not tested

## Nx Server Docker container support conditions ##

*  Nx Server Docker container is an experimental feature.
*  It has not been comprehensively tested.
*  It is not recommended for critical systems.
*  Please, test carefully that all features work in your environment before using it.
*  We do not guarantee support, but we need your feedback and will try to address discovered 
issues in future releases.
*  Any support provided implies knowledge and skills of Docker when using this feature.

## Building ##

Building an image from current directory

You can use build.sh utility:

```bash
# Building from existing debian package. It will copy it to the build folder and build the image.
build.sh ~/Downloads/nxwitness-server-4.0.0.28737-linux64-beta-test.deb

# Or using url. It will download the debian package and build the image.
build.sh https://beta.networkoptix.com/beta-builds/default/28608/linux/nxwitness-server-4.0.0.28608-linux64-beta-prod.deb
```
| Parameter | Effect |
| --------- | ------ |
| -d --deb <path to deb file> | Uses deb file as a source. |
| -b --build <path to build folder> | Uses build folder as a source. |
| -c --cust <customization name> | Changes the customization to the desired one. |
| -u --url <url to download> | Uses URL as a source for debian file. Will automatically set customization based on url.|
| -n --name <name> |   Sets the name for the container.  Default is 'mediaserver'. |
| -h --host <new cloud host url> | Changes the cloud host.  This is for testing purposes. |
| -v --verbose | Gives verbose output when run. |

The script will use current directory as a docker workspace. It also copies necessary 
files (deb package) to this folder.

You can use docker directly:

```bash
docker build -t mediaserver --build-arg mediaserver_deb=path_to_mediaserver.deb .
```

It will fetch all necessary layers and build docker image with name `mediaserver`.

## Running ##

Running it:

```bash
sudo docker run -d --name mediaserver1 -t mediaserver
```

OR

You can use the docker-compose file which has the run parameters set, and will provide 
volumes for persistent database and video storage.

If you are already running a Nx Server on host in the traditional way, you will either want to 
change the port setting of your server or update the port setting in the docker-compose.yaml file.
Make sure you don't have too many Docker images filing up space either. Even if the Nx Desktop 
client sees that the mounted directory has space but is filled with other things, it may claim the 
storage location is inaccessible and show Invalid storage on the Storage Management tab in Server Settings.

The docker-compose.yaml file will give you one storage location for video. If you want more storage 
locations you will need to mount additional volumes to the container.  Note that these need to be 
separate volumes on the host as well. 

### For example: ###

| Mount location | Effect |
| -------------- | ------- |
| ./video:/recordings | Mounts video storage on the volume ./video as /recordings in the Docker container. |
| ./data/:/opt/networkoptix/mediaserver/var | Mounts DB storage on the volume ./data as /opt/networkoptix/mediaserver/var in the Docker container. |
| /media/user/f9b06bbd-8d74-4bb6-a7f3-2799223ec517/video2:/dock2 | Mounts /media/user/f9b06bbd-8d74-4bb6-a7f3-2799223ec517/video2 as /dock2 in the Docker container. |
| /media/user/c84fcf04-bc47-47ee-8e47-5c4f15822e8b/video3:/dock3 | Mounts /media/user/c84fcf04-bc47-47ee-8e47-5c4f15822e8b/video3 as /dock3 in Docker container. |

Note that the video storage location, if modified, needs to be short. Changing the name 
is fine but changing the path may result in no valid storage location.

### Notes about storage ###
Note that the media server still retains it's limitations regarding valid storage locations.
Here is the current (as of May 28, 2020) list of valid filesystem types supported:
* vfat
* ecryptfs
* fuseblk //NTFS
* fuse
* fusectl
* xfs
* ext3
* ext2
* ext4
* exfat
* rootfs
* nfs
* nfs4
* nfsd
* cifs
* fuse.osxfs

If you want to use a file system type from outside this list, know that it is use at your own risk
and is not supported.  We do however, have an option in advanced settings that can bypass our 
requirements.

1. Sign into the web client (usuall localhost:7001).
2. Go to /static/index.html#/advanced
3. There should be a field with this label:
    "Additional file system types to consider while deciding if a given partition is suitable to be a server storage"
4. Input the file system name and click save at the bottom.


## Useful commands ##

Entering bash inside named container:
```bash
sudo docker exec -i -t mediaserver /bin/bash #< by name
```

Reading system logs:

```bash
sudo docker logs mediaserver
```

Reading journalctl:

```bash
sudo docker exec -i -t mediaserver journalctl -u networkoptix-mediaserver
```

Stopping the container and resetting all the data:

```
sudo docker stop mediaserver && sudo docker rm mediaserver
```

## Networking ##

The network setting of Docker container can influence Nx Server availability. Here is summary of 
the network types you can use, and the results you can expect.

### Host (recommended) ###
Licenses in this mode will always have the MAC of the host and the MAC can't be modified 
in "host" mode.

#### Pros: ####
*  No need to do any network configuration
*  Auto-discovery works
*  Other systems on the network can see your server

#### Cons: ####
*  Does not work on MacOS
    
### Bridge ###
#### Pros: ####
*  No need to do any network configuration
*  Works on MacOS

#### Cons: ####
*  The MAC address can change if you start up Servers in a different order invalidating the 
license.
*  Must connect to server manually in the desktop client
*  Auto-discovery does not work.  Cameras need to be added manually.

### Macvlan ###
For details see: https://docs.docker.com/v17.12/network/macvlan/

#### Pros: ####
*  Auto-discovery works
*  You can run multiple servers on your host

#### Cons: ####
*  Requires complicated configuration, including changes in DHCP server in your network and 
creating docker network. 
(See for details: https://docs.docker.com/v17.09/engine/userguide/networking/get-started-macvlan/).
*  Requires your network adapter to be in "Promiscuous" mode which can be a security risk. 
(Details here: https://searchsecurity.techtarget.com/definition/promiscuous-mode)
*  IP changes will invalidate the license unless you specify a MAC address when running the 
container.

## Licenses considerations ##

Licenses are tied to Hardware ID (HWID). Changing one identifier (including MAC) causes the HWID to 
change. That's why HWID can be accidentally invalidated by modifications to the Docker container.

For more explanations about HWID see:
https://support.networkoptix.com/hc/en-us/articles/360036141153-HWID-changed-and-license-is-no-longer-recording

There are several ways that changes to the network settings can cause the HWID to change:

*  Switching container network mode from host to bridge;
*  Starting up containers in bridged mode causes them to choose sequential MAC addresses.  If 
containers are started in a different order after license keys are <code>ssigned</code>, their 
MAC address will change, also changing the HWID, and invalidating the licenses;
*  Deliberately changing the MAC address of a container;
*  Changes to internal IP of the container can cause the MAC address to change as well;
*  Moving the Docker image to another host.

This can be solved by specifying MAC address in the docker run command or in docker-compose.yaml file. For example,
```
sudo docker run -d --mac-address="8a:ca:58:b9:e9:51" --network bridge --name mediaserver1 --tmpfs /run --tmpfs /run/lock -v /sys/fs/cgroup:/sys/fs/cgroup:ro -t mediaserver
```
Actions that won't invalidate a license:

*  In-client update;
*  Building a new Docker image with a new Server version but same MAC address and DB on the same host;
*  Stopping and starting the container;
*  Removing the container and starting it again from the same image and DB on the same host.

Note: If your license has been invalidated, it can be reactivated up to 3 times by contacting 
support. For more details see https://support.networkoptix.com/hc/en-us/articles/360036141153-HWID-changed-and-license-is-no-longer-recording

## Software Updates ##

Both in-client and manual image updates will invalidate licenses.

In-client update:
Currently in-client update works but several limitations. 

Since we removed the use of systemd from the image, in-client updates will no longer work.  Please refer to the below method.

Updating the image itself:

1.  Stop your container.
2.  Move the copy of the DB and recorded video to another folder.
3.  Stop and Remove container.
    * sudo docker container stop <container id>
    * sudo docker container rm <container id>
4.  Remove Docker image.
    * sudo docker image rm <image id>
5.  Build new Docker image with the new Server version.
6.  Bring DB and video files back.
7.  Run the new image referencing the DB and video files.

## MacOS support ##

With this Docker container you can run a container on MacOS. It does come with some limitations.

*  "Host" networking will not work as the MacOS puts the Docker container inside a VM, not 
directly on the main OS. See https://docs.docker.com/docker-for-mac/networking/ for details.
*  "Bridge" is probably the best option but for the reasons above requires some manual 
addition of servers and cameras


## TODO ##

1. ~~Provide a better ways to specify deb file for mediaserver.~~ Done
1. Provide some scripts to simplify start & restart.
1. Interaction with cmake.
