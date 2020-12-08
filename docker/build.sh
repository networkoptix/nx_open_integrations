#!/bin/bash
CUSTOMIZATION=$1
BASEDIR=/opt/$CUSTOMIZATION/mediaserver
sudo /opt/$CUSTOMIZATION/mediaserver/bin/root-tool-bin&
$BASEDIR/bin/mediaserver-bin  -e
docker-server-factory@dockerserverfactory-VirtualBox:~/DockerQA$ #!/bin/bash CUSTOMIZATION=$1 BASEDIR=/opt/$CUSTOMIZATION/mediaserver sudo /opt/$CUSTOMIZATION/mediaserver/bin/root-tool-bin& $BASEDIR/bin/mediaserver-bin  -e^C docker-server-factory@dockerserverfactory-VirtualBox:~/DockerQA$ ^C
docker-server-factory@dockerserverfactory-VirtualBox:~/DockerQA$ cat build.sh
#!/bin/bash
# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

# This is helper script for building docker image from debian package for mediaserver

display_usage() {
        set +x
        echo "This is a helper script for building docker images from a debian package for a VMS Server."
        echo -e "Usage:\nbuild.sh [-u url ] | [-d deb] | path\n"
        echo "Possible arguments:"
        echo -e " -d|--deb PATH - use deb file as a source"
        echo -e " -b|--build PATH - use build folder as a source"
        echo -e " -u|--url URL - use URL as a source for debian file"
        echo -e " -v|--verbose - enables verbose mode. It will mirror all commands to stdout"
}

# Path to a folder with Dockerfile and necessary scripts.
DOCKER_SOURCE=`pwd`
DOCKERFILE="${DOCKER_SOURCE}/Dockerfile"

# Path to current docker build folder.

DOCKER_BUILD_DIRECTORY=$(pwd)

# Name of docker container to be built.
CONTAINER_NAME=mediaserver
CLOUD_HOST_OVERRIDE=""
POSITIONAL=()
ECHO_OUTPUT=false

# Stops the script on error.
set -e

# Processing command line arguments.
while [[ $# -gt 0 ]]
        do
        key="$1"

                case $key in
                        -d|--deb)
                                # Will use existing deb file.
                                DEB_FILE="$2"
                                shift
                                shift
                                ;;
                        -b|--build)
                                # Will use nx_vms build folder as source.
                                BUILD_PATH="$2"
                                shift
                                shift
                                ;;
                       # -c|--cust)
                       #         # Will override the default customization.
                       #         CUSTOMIZATION="$2"
                       #         shift
                       #         shift
                       #         ;;
                        -u|--url)
                                # Will use url to deb file as source.
                                DEB_URL="$2"
                                shift
                                shift
                                ;;
                        -n|--name)
                                # Name for container. By default it is 'mediaserver'.
                                IMAGE_NAME="$2"
                                shift
                                shift
                                ;;
                        -h|--host)
                                CLOUD_HOST_OVERRIDE="$2"
                                shift
                                shift
                                ;;
                        -v|--verbose)
                                ECHO_OUTPUT=true
                                shift
                                ;;
                        *)
                                POSITIONAL+=("$1")
                                shift
                                ;;
                esac
done

if $ECHO_OUTPUT
        then
                # Runs script with a trace of the commands performed.
                set -x
fi

# Trying to guess what to do with positional arguments.
for deb_location in "${POSITIONAL[@]}"
        do
                if [[ $deb_location == http://* ]] || [[ $deb_location == https://* ]] ;
                        then
                                #echo "The path ${SS}$path${EE} looks like URL. I will try to download it".
                                DEB_URL=$deb_location
                else
                        #echo "The path ${SS}$path${EE} looks like regular file. I will copy it to current directory".
                        DEB_FILE=$deb_location
                fi
done

raise_error()
{
        >&2 echo -e "ERROR: $1. Exiting..."
        exit 1
}

# Style options to display paths and important variables.
SS="\e[4m"
EE="\e[0m"

# Checks whether deb file exists and is valid.
check_dpkg ()
{
        local -r file=$1

        if [[ ! -r $file ]]
                then
                        raise_error "File ${SS}$file${EE} does not exist or I can not access it"
        fi
        # Trying to check whether this file is a proper DEB package.
        if hash dpkg 2>/dev/null;
                then
                        dpkg -I "$file" 1>/dev/null || raise_error "${SS}${file}${EE} is not a deb file"
        else
                # Some hosts do not have 'dpkg', so we check extension only.
                [[ $file == *.deb ]] || raise_error "${SS}${file}${EE} does not look like deb package"
        fi
        return 0
}

if [ ! -r $DOCKERFILE ]
        then
                raise_error "${SS}${DOCKERFILE}${EE} does not exists. It should be near to build.sh script"
fi


if [[ ! -z $DEB_FILE ]]
    then
        echo -e "I will try to use deb file ${SS}${DEB_FILE}${EE}"
        check_dpkg "$DEB_FILE"
        cp "$DEB_FILE" "$DOCKER_SOURCE/"
        DEB_NAME=$(basename $DEB_FILE)
else
    if [[ ! -z $DEB_URL ]]
        then
            # Grab the customization from production urls
            re="(http.?:\/{2}updates\..*\.com\/)([^\/]*)"
            [[ $DEB_URL =~ $re ]] && CUSTOMIZATION=${BASH_REMATCH[2]}

            # Grab the customization from beta urls
            re="(http.?:\/{2}beta\..*\.com\/)(beta-builds\/)([^\/]*)"
            [[ $DEB_URL =~ $re ]] && CUSTOMIZATION=${BASH_REMATCH[3]}

            echo -e "I will try to download mediaserver deb from ${SS}${DEB_URL}${EE}"
            curl -o mediaserver.deb $DEB_URL 1>/dev/null || raise_error "Failed to download from ${SS}$DEB_URL${EE}"
            DEB_NAME=mediaserver.deb
            check_dpkg "$DEB_NAME"
        else
            echo "ERROR: Neither URL nor direct path are specified" >&2
            display_usage
            exit 1
            # Trying to use build folder for nx_vms and take deb from there.
            # TODO: implement it properly.
            # TODO: Enable distribution build.
            # TODO: Clean up previous build if necessary.
            # TODO: Find output name for debian file.
            #ninja -C "${BUILD_PATH}" distribution_deb_mediaserver.
    fi
fi
# Set the CUSTOMIZATION variable to default if it was not set by -c or by the url
re="\/opt\/([a-z]*)\/mediaserver"
conts=$(dpkg --contents $DEB_NAME)
if [[ $conts =~ $re ]]; then
        echo ${BASH_REMATCH[1]};
else
        echo "no match"
fi

#CUSTOMIZATION=${CUSTOMIZATION:-"networkoptix"}
#if [ "${CUSTOMIZATION}" == "default" ]; then CUSTOMIZATION="networkoptix"; fi
IMAGE_NAME="test"
echo -e "Building container at ${SS}${DOCKER_SOURCE}${EE} using mediaserver_deb=$DEB_NAME name=$IMAGE_NAME cust=${BASH_REMATCH[1]}"
docker build -t 4.1_test --build-arg mediaserver_deb="$DEB_NAME" --build-arg cust="${BASH_REMATCH[1]}" .