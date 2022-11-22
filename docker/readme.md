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

Recommended way is to use [docker-compose >= 1.25](https://docs.docker.com/compose/) utility.
Follow [Installation guide](https://docs.docker.com/compose/install/).


Review [build environment configuration](.env). Build image:

```bash
docker-compose build
```

## Running ##

If a host is already running a VMS Server in the traditional way, port setting have to be different
for the container Server and the Server on a host. Also, make sure you don't have too many Docker
images filing up the space. Even if the Desktop Client sees that the mounted directory has space
but is filled with other things, it may claim the storage location inaccessible and show "Invalid
Storage" on the Storage Management tab in Server Settings.

The docker-compose.yaml file will give you one storage location for video. If you want more storage
locations, you will need to mount additional volumes to the container. Note that these need to be
separate volumes on the host as well.

Volumes are required to configure the Sever and save its state data.

### Volumes description: ###

| Default source mount location | Description               | Container mount point             |
| ----------------------------- | ------------------------- | --------------------------------- |
| /srv/mediaserver/entrypoind.d | User init scripts         | /opt/mediaserver/entrypoint.d     |
| /srv/mediaserver/etc          | Configuration             | /opt/networkoptix/mediaserver/etc |
| /srv/mediaserver/nx_ini       | Additional configuration  | /home/${COMPANY}/.config/nx_ini   |
| /srv/mediaserver/recordings   | Video storage             | /recordings                       |
| /srv/mediaserver/var          | State and logs            | /opt/networkoptix/mediaserver/var |
| /srv/mediaserver/tmp          | Unix socket and tmp files | /opt/networkoptix/mediaserver/tmp |

Note that the video storage location, if modified, needs to be short. Changing the name 
is fine but changing the path may result in no valid storage location.

The default location of the volumes is specified at [environment file](.env).

```bash
# Run as root or use sudo.
# Create /srv/mediaserver directory.
install -d /srv/mediaserver

# Copy the example volumes to /srv/mediaserver/ directory and set permissions - the directory has
# to be owned by a VMS Server user with UID & GID equal to 999.
cp -a config-volumes/* /srv/mediaserver
chown 999:999 -R /srv/mediaserver

# Review configurations and scripts - amend according to your needs.

# Run containers in the daemon mode.
docker-compose up -d
```

# Clean up.
```bash
# Stop services and remove containers.
docker-compose down

# Remove state volumes.
rm -rf /srv/mediaserver
```

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
*  Multiple servers on the same host will have the same MAC address and will appear as "duplicates" if you try to merge them
    
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
Run:
```bash
docker-compose down

# Update the version in the .env file.

docker-compose build
docker-compose up -d 
```

## MacOS support ##

With this Docker container you can run a container on MacOS. It does come with some limitations.

*  "Host" networking will not work as the MacOS puts the Docker container inside a VM, not 
directly on the main OS. See https://docs.docker.com/docker-for-mac/networking/ for details.
*  "Bridge" is probably the best option but for the reasons above requires some manual 
addition of servers and cameras
