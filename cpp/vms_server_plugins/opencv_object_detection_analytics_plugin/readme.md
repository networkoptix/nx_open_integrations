// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

# OpenCV-based Analytics Plugin for the VMS Server (opencv_object_detection_analytics_plugin)

## Features

- Detect objects (cats, dogs, people).
- Send object detection events.
- Send plugin diagnostics events.

## Supported platforms

Prerequisites:
    CMake >= 3.15 
    Conan >= 1.53 and <= 1.59
    MetaVMS = 5.1.0.37133
    Metadata SDK = 5.1.0.37133
    g++ compiler >= 9 and <= 10.5
    
The plugin has been tested in the following environments.

Ubuntu 20.04, g++ compiler version 10.5
Windows 10, Visual Studio 2022.

## Model files

The plugin uses MIT licensed MobileNet SSD model files from https://github.com/chuanqi305/MobileNet-SSD.
They will be downloaded automatically by CMake.

## Building plugins

### Environment vairables
On Linux
```
export SERVER_DIR=/opt/networkoptix-metavms/mediaserver
```

On Windows
```
set SERVER_DIR="c:\Program Files\Network Optix\Nx MetaVMS\mediaserver"
```

### Building
Change to the root directory of the plugin (the directory of this readme.md file).

Build the plugin as an ordinary CMake-based project, supplying the path to the Metadata SDK.

For example, here is how to build the step 1:
```
mkdir build
cd build
cmake -DmetadataSdkDir=/PATH_TO_METADATA_SDK/ -DCMAKE_BUILD_TYPE=Release ../step1
cmake --build . --config Release
```

### Activating plugins
For steps 1 and 2 simply copy the resulting library binary to the VMS "plugins" directory:
On Linux
```
sudo systemctl stop networkoptix-metavms-mediaserver
sudo cp libopencv_object_detection_analytics_plugin.so $SERVER_DIR/bin/plugins/
sudo systemctl start networkoptix-metavms-mediaserver
```

On Windows with Administrator rights
```
sc stop metavmsMediaServer
copy Release\opencv_object_detection_analytics_plugin.dll %SERVER_DIR%\plugins\
sc start metavmsMediaServer
```

For further steps, remove the library copied on a previous step, and then create the plugin directory and
copy there the resulting library file along with model files:

On Linux
```
sudo systemctl stop networkoptix-metavms-mediaserver
sudo rm $SERVER_DIR/bin/plugins/opencv_object_detection_analytics_plugin.so
sudo mkdir $SERVER_DIR/bin/plugins/opencv_object_detection_analytics_plugin
sudo cp lib/libopencv_object_detection_analytics_plugin.so MobileNetSSD.caffemodel MobileNetSSD.prototxt $SERVER_DIR/bin/plugins/opencv_object_detection_analytics_plugin/
sudo systemctl start networkoptix-metavms-mediaserver
```

On Windows with Administrator rights
```
sc stop metavmsMediaServer
del %SERVER_DIR%\plugins\opencv_object_detection_analytics_plugin.dll
mkdir %SERVER_DIR%\plugins\opencv_object_detection_analytics_plugin
copy Release\opencv_object_detection_analytics_plugin.dll MobileNetSSD.caffemodel MobileNetSSD.prototxt %SERVER_DIR%\plugins\opencv_object_detection_analytics_plugin\
sc start metavmsMediaServer
```

