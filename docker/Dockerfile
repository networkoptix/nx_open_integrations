FROM ubuntu:18.04
# Takes the customization and applies it as a build ARG and an ENV so it can be passed to the entrypoint

# This will override our EULA check.
ENV DEBIAN_FRONTEND noninteractive

# This is the deb file used to install mediaserver
ARG mediaserver_deb
ARG cust

# Make a location to copy in the deb filee
RUN mkdir /debs

# Copy the deb file into the container
COPY "${mediaserver_deb}" /debs/

# Install the mediaserver and give user permissions for root-tool

RUN apt-get update \
    && apt-get install -y \/debs/${mediaserver_deb} sudo \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/ \
    && echo "${cust} ALL = NOPASSWD: /opt/${cust}/mediaserver/bin/entrypoint.sh, /opt/${cust}/mediaserver/bin/root-tool-bin" > /etc/sudoers.d/${cust}
# Move the entrypoint script into the container
COPY entrypoint.sh /opt
# Set the user to run the commands to the networkoptix user created on installation
USER ${CUSTOMIZATION}
ENV CUSTOMIZATION ${cust}

# Runs the media server and root-tool on container start
ENTRYPOINT ["/bin/sh", "-c", "/opt/entrypoint.sh ${CUSTOMIZATION}"]