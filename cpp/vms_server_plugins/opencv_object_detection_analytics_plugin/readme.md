// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
# Analytics plugin for Nx VMS Server (opencv\_object\_detection\_analytics\_plugin)

## Features
- Detect objects (cats, dogs, people).
- Send object detection events.
- Send plugin diagnostics events.

## Supported platforms
Ubuntu 18.04, g++-7 compiler.

At the present moment, this plugin is only compatible with Meta 4.1.0.30142 R2 SDK. The compiled
plugin is backward compatible with VMS 4.0.

## Model files
The plugin uses MIT licensed MobileNet SSD model files from https://github.com/chuanqi305/MobileNet-SSD.
They will be downloaded automatically by CMake.

## Build
The plugin requires CMake >= 3.3.2 and Conan >= 1.19.1 to be built.

Conan default profile should be updated to use new CXX11 ABI:
```
$ conan profile new default --detect  # Ignore the line "ERROR: Profile already exists" if it was printed.
$ conan profile update settings.compiler.libcxx=libstdc++11 default
```

To build the plugin cd to the root directory of the plugin (the directory of this readme.md file).

Then build it as an ordinary CMake-based project, supplying the path to the metadata SDK dir.

Here is how to build the step1:
```
$ mkdir build
$ cd build/
$ cmake -DmetadataSdkDir=/PATH_TO_METADATA_SDK/ -DCMAKE_BUILD_TYPE=Release ../step1
$ cmake --build .
```

For steps 1 and 2 simply copy the resulting library file to the plugins directory:
```
$ sudo cp libopencv_object_detection_analytics_plugin.so /PATH_TO_VMS/bin/plugins/
```

For further steps remove the library copied for previous steps and then create the plugin dir and
copy the resulting library file and model files to it:
```
$ sudo mkdir /PATH_TO_VMS/bin/plugins/opencv_object_detection_analytics_plugin
$ sudo cp lib/libopencv_object_detection_analytics_plugin.so MobileNetSSD.caffemodel MobileNetSSD.prototxt /PATH_TO_VMS/bin/plugins/opencv_object_detection_analytics_plugin/
```
