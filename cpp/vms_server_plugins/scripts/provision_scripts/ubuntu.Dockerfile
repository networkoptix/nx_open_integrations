## Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

# Container for building the plugins in cpp/vms_server_plugins/ for the 6.1 Server on Linux:
# Ubuntu 24.04 with GCC 13 and CMake 3.28. From the repository root, build the image, then build a
# plugin in the container with the repository and the SDK mounted, e.g.:
#
#     docker build -t nx-plugin-build -f cpp/vms_server_plugins/scripts/provision_scripts/ubuntu.Dockerfile cpp/vms_server_plugins/scripts/provision_scripts
#     docker run --rm -it -v "$PWD:/src" -v "$HOME/nx_sdk:/sdk" -w /src nx-plugin-build
#
# To also install Clang: docker build --build-arg PROVISION_ARGS=--clang ...

FROM ubuntu:24.04

ARG PROVISION_ARGS=""

COPY provision_ubuntu.sh setup_conan.sh download_sdk.py /opt/nx_scripts/
RUN /opt/nx_scripts/provision_ubuntu.sh $PROVISION_ARGS && rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.local/bin:${PATH}"
CMD ["bash"]
