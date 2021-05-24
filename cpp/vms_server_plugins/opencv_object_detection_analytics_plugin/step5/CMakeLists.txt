## Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

cmake_minimum_required(VERSION 3.3.2)
project(opencv_object_detection_analytics_plugin)

set(metadataSdkVersion "4.2.0 R3")
set(metadataSdkDir "" CACHE PATH
    "Path to unpacked VMS Metadata SDK zip. Tested with version ${metadataSdkVersion}.")

if(metadataSdkDir STREQUAL "")
    message(FATAL_ERROR "metadataSdkDir cache variable is undefined.")
endif()

# Download OpenCV automatically using Conan
if(NOT EXISTS "${CMAKE_BINARY_DIR}/conan.cmake")
   message(STATUS "Downloading conan.cmake from https://github.com/conan-io/cmake-conan")
   file(DOWNLOAD "https://raw.githubusercontent.com/conan-io/cmake-conan/master/conan.cmake"
       "${CMAKE_BINARY_DIR}/conan.cmake")
endif()
include(${CMAKE_BINARY_DIR}/conan.cmake)
conan_cmake_run(BUILD_TYPE "Release")
conan_add_remote(NAME nx_open_integrations INDEX 0
     URL https://networkoptix.jfrog.io/artifactory/api/conan/nx_open_integrations)
if(UNIX)
	conan_cmake_run(BASIC_SETUP 
		PATH_OR_REFERENCE protobuf/3.5.2@bincrafters/stable 
		REMOTE nx_open_integrations)
	conan_cmake_run(REQUIRES opencv/4.1.1@networkoptix/stable 
		BASIC_SETUP)
elseif(WIN32)
	if(NOT DEFINED ENV{OPENCV_DIR})
		message(FATAL_ERROR 
		"OPENCV_DIR environment variable is undefined.\n"
		"Download OpenCV pre-built library for Windows from https://sourceforge.net/projects/opencvlibrary/files/4.1.1/opencv-4.1.1-vc14_vc15.exe/download\n"
		"Follow instruction at https://docs.opencv.org/master/d3/d52/tutorial_windows_install.html")
	endif()
	set(OPENCV_DIR $ENV{OPENCV_DIR})
	find_package(OpenCV REQUIRED PATHS "${OPENCV_DIR}/lib")
endif()

# Download model files
message("Downloading model files:")
if (NOT EXISTS ${CMAKE_BINARY_DIR}/MobileNetSSD.caffemodel)
    message("MobileNetSSD.caffemodel")
    file(DOWNLOAD https://networkoptix.jfrog.io/artifactory/nx_open_integrations/MobileNetSSD.caffemodel ${CMAKE_BINARY_DIR}/MobileNetSSD.caffemodel SHOW_PROGRESS)
else()
    message("MobileNetSSD.caffemodel already exists.")
endif()
if (NOT EXISTS ${CMAKE_BINARY_DIR}/MobileNetSSD.prototxt)
    message("MobileNetSSD.prototxt")
    file(DOWNLOAD https://networkoptix.jfrog.io/artifactory/nx_open_integrations/MobileNetSSD.prototxt ${CMAKE_BINARY_DIR}/MobileNetSSD.prototxt SHOW_PROGRESS)
else()
    message("MobileNetSSD.prototxt already exists.")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_EXTENSIONS OFF)

set(CMAKE_CXX_VISIBILITY_PRESET hidden)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(UNIX)
    # In Linux, for the plugin .so library, set `rpath` to "$ORIGIN" and do not set `runpath`, thus
    # enabling the lookup of the dependencies in the plugin dir first.
    string(APPEND CMAKE_SHARED_LINKER_FLAGS " -Wl,--disable-new-dtags")
endif()
set(CMAKE_SKIP_BUILD_RPATH ON)
set(CMAKE_BUILD_WITH_INSTALL_RPATH ON)
set(CMAKE_INSTALL_RPATH "$ORIGIN")

if(WIN32)
    set(API_EXPORT_MACRO "__declspec(dllexport)")
elseif(UNIX)
    set(API_EXPORT_MACRO "__attribute__((visibility(\"default\")))")
endif()

#--------------------------------------------------------------------------------------------------
# Define nx_kit lib, static.

set(nxKitLibraryType "STATIC" CACHE STRING "" FORCE)
set(nxKitWithTests "YES" CACHE STRING "" FORCE)

add_subdirectory(${metadataSdkDir}/nx_kit ${CMAKE_CURRENT_BINARY_DIR}/nx_kit)

#--------------------------------------------------------------------------------------------------
# Define nx_sdk lib, static, depends on nx_kit.

set(SDK_SRC_DIR ${metadataSdkDir}/src)
file(GLOB_RECURSE SDK_SRC ${SDK_SRC_DIR}/*)

add_library(nx_sdk STATIC ${SDK_SRC})
target_include_directories(nx_sdk PUBLIC ${SDK_SRC_DIR})
target_link_libraries(nx_sdk PRIVATE nx_kit)

target_compile_definitions(nx_sdk PRIVATE NX_PLUGIN_API=${API_EXPORT_MACRO})

#--------------------------------------------------------------------------------------------------
# Define opencv_object_detection_analytics_plugin lib, dynamic, depends on nx_kit and nx_sdk.


set(OPENCV_OBJECT_DETECTION_ANALYTICS_PLUGIN_SRC_DIR ${CMAKE_CURRENT_LIST_DIR}/src)
file(GLOB_RECURSE OPENCV_OBJECT_DETECTION_ANALYTICS_PLUGIN_SRC
    ${OPENCV_OBJECT_DETECTION_ANALYTICS_PLUGIN_SRC_DIR}/*)

add_library(opencv_object_detection_analytics_plugin SHARED
    ${OPENCV_OBJECT_DETECTION_ANALYTICS_PLUGIN_SRC})
target_include_directories(opencv_object_detection_analytics_plugin PRIVATE 
    ${OPENCV_ANALYTICS_PLUGIN_SRC_DIR} ${CONAN_INCLUDE_DIRS} ${OpenCV_INCLUDE_DIRS})
set(CMAKE_EXE_LINKER_FLAGS " -static")
target_link_libraries(opencv_object_detection_analytics_plugin
    nx_kit
    nx_sdk
    ${CONAN_LIBS}
   -static-libgcc
   -static-libstdc++
   ${OpenCV_LIBS})

target_compile_definitions(opencv_object_detection_analytics_plugin
    PRIVATE NX_PLUGIN_API=${API_EXPORT_MACRO}
)
