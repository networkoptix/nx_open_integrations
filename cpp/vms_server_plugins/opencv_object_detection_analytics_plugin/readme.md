// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
# Analytics plugin for Nx VMS Server (opencv\_object\_detection\_analytics\_plugin)

## Features
- Detect objects (cats, dogs, people).
- Send object detection events.
- Send plugin diagnostics events.

## Supported platforms
Ubuntu 18.04, g++-7 compiler.

At the present moment, this plugin is only compatible with Meta 4.1.0.30087 R1 SDK. The compiled
plugin is backward compatible with VMS 4.0.

## Download model files
The plugin uses MIT licensed MobileNet SSD model files from https://github.com/chuanqi305/MobileNet-SSD.

The archive with model files can be downloaded from https://drive.google.com/file/d/1eftS1jUgmXeTXzZ2jG4D_z7xW-bl_Vl4/view?usp=sharing.

After downloading the archive should be extracted.

## Build
The plugin requires CMake >= 3.3.2 and Conan >= 1.19.1 to be built.

To build the plugin cd to the root directory of the plugin (the directory of this readme.md file).

Then build it as an ordinary CMake-based project, supplying the path to the metadata SDK dir.

Here is how to build the step1:
```
$ mkdir build
$ cd build/
$ cmake -DmetadataSdkDir=/path/to/metadata_sdk/ ../step1
$ cmake --build .
```

Then create the plugin dir and copy the resulting library file and model files to it:
```
$ sudo mkdir /PATH_TO_VMS/bin/plugins/opencv_object_detection_analytics_plugin
$ sudo cp libopencv_object_detection_analytics_plugin.so /PATH_TO_VMS/bin/plugins/opencv_object_detection_analytics_plugin/
$ sudo cp /PATH_TO_MODEL_FILES/* /PATH_TO_VMS/bin/plugins/opencv_object_detection_analytics_plugin/
```
