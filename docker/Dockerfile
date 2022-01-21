# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

FROM ubuntu:20.04
LABEL maintainer "Network Optix <support@networkoptix.com>"

# VMS Server debian package file or URL.
ARG MEDIASERVER_DEB="http://updates.networkoptix.com/default/4.2.0.32840/linux/nxwitness-server-4.2.0.32840-linux64.deb"

# VMS Server user and directory name.
ARG COMPANY="networkoptix"
# Also export as environment variable to use at entrypoint.
ENV COMPANY=${COMPANY}

# Disable EULA dialogs and confirmation prompts in installers.
ENV DEBIAN_FRONTEND noninteractive

# Copy the .deb file into the container.
ADD "${MEDIASERVER_DEB}" /opt/mediaserver/package/

# Install packages.
RUN apt-get update && \
    apt-get install -y \
        apt-utils \
        binutils \
        curl \
        /opt/mediaserver/package/${MEDIASERVER_DEB##*/} && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Fix permissions.
RUN chown ${COMPANY}: /opt/${COMPANY}/mediaserver/var/

ADD entrypoint.sh /opt/mediaserver/

USER ${COMPANY}
WORKDIR /home/${COMPANY}

# Runs the media server on container start unless argument(s) specified.
ENTRYPOINT ["/opt/mediaserver/entrypoint.sh"]
