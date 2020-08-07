FROM ubuntu:18.04

# Takes the customization override and applies it
ARG cust
ENV customization=${cust:-networkoptix} 
# This will override our EULA check.
ENV DEBIAN_FRONTEND noninteractive

# This is the deb file used to install mediaserver
ARG mediaserver_deb

# Make a location to copy in the deb filee
RUN mkdir /debs

# Copy the deb file into the container
COPY "${mediaserver_deb}" /debs/

# Install the mediaserver and give user permissions for root-tool
RUN apt-get update \
    && apt-get install -y \/debs/${mediaserver_deb} sudo \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/ \
    && echo "${customization} ALL = NOPASSWD: /opt/${customization}/mediaserver/bin/entrypoint.sh, /opt/${customization}/mediaserver/bin/root-tool-bin" > /etc/sudoers.d/${customization} 

# Move the entrypoint script into the container
COPY entrypoint.sh /opt/${customization}/mediaserver/bin/

# Set the user to run the commands to the networkoptix user created on installation
USER ${customization}

# Runs the media server and root-tool on container start
ENTRYPOINT ["/bin/sh", "-c", "/opt/${customization}/mediaserver/bin/entrypoint.sh ${customization}"]