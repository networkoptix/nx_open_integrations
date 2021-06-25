## Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

cmake_minimum_required(VERSION 3.15)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")
project(opencv_object_detection_analytics_plugin)

set(metadataSdkVersion "4.2.0.32836 R4")
set(metadataSdkDir "" CACHE PATH
    "Path to unpacked VMS Metadata SDK zip. Tested with version ${metadataSdkVersion}.")

if(metadataSdkDir STREQUAL "")
    message(FATAL_ERROR "metadataSdkDir cache variable is undefined.")
endif()

if(NOT DEFINED ARTIFACTORY_URL)
    set(ARTIFACTORY_URL "https://resources.vmsproxy.com/nx_open_integrations")
endif()

list(APPEND CMAKE_MODULE_PATH ${CMAKE_BINARY_DIR})
list(APPEND CMAKE_PREFIX_PATH ${CMAKE_BINARY_DIR})

# Download OpenCV automatically using Conan
if(NOT EXISTS "${CMAKE_BINARY_DIR}/conan.cmake")
   message(STATUS "Downloading conan.cmake from https://github.com/conan-io/cmake-conan")
   file(DOWNLOAD "https://raw.githubusercontent.com/conan-io/cmake-conan/master/conan.cmake"
       "${CMAKE_BINARY_DIR}/conan.cmake")
endif()
include(${CMAKE_BINARY_DIR}/conan.cmake)

if(WIN32)
    set(CONAN_VS_RUNTIME_MT_SETTING "compiler.runtime=MT")
endif()
set(OPENCV_OPTIONS
    opencv:parallel=False
    opencv:contrib=True
    opencv:contrib_freetype=False
    opencv:contrib_sfm=False
    opencv:with_jpeg=False 
    opencv:with_png=False
    opencv:with_tiff=False
    opencv:with_jpeg2000=False
    opencv:with_openexr=False
    opencv:with_eigen=False
    opencv:with_webp=False
    opencv:with_quirc=False
    opencv:with_cuda=False
    opencv:with_cublas=False
    opencv:dnn=True
)

if(UNIX)
    set(OPENCV_OPTIONS 
        ${OPENCV_OPTIONS}
        opencv:fPIC=True
        opencv:with_gtk=False
        opencv:with_cufft=False
        opencv:with_v4l=False
    )
endif()

conan_cmake_run(BUILD_TYPE "Release")
conan_cmake_configure(REQUIRES opencv/4.1.2
    GENERATORS cmake_find_package
    OPTIONS ${OPENCV_OPTIONS}
    SETTINGS ${CONAN_VS_RUNTIME_MT_SETTING}
)

conan_cmake_install(PATH_OR_REFERENCE .
    OPTIONS ${OPENCV_OPTIONS}
    SETTINGS ${CONAN_VS_RUNTIME_MT_SETTING}
    BUILD missing
)

find_package(OpenCV REQUIRED)

# Download model files
set(model_file_names
    MobileNetSSD.caffemodel
    MobileNetSSD.prototxt
)
foreach(model_file_name IN LISTS model_file_names)
    set(model_file "${CMAKE_BINARY_DIR}/${model_file_name}")
    list(APPEND model_files "${model_file}")
    if(NOT EXISTS "${model_file}")
        message("Downloading ${model_file_name}")
        file(DOWNLOAD
            "${ARTIFACTORY_URL}/opencv/${model_file_name}"
            "${model_file}"
            SHOW_PROGRESS
            STATUS DOWNLOAD_STATUS
        )
        list(GET DOWNLOAD_STATUS 0 STATUS_CODE)
        if(NOT STATUS_CODE EQUAL 0)
            file(REMOVE "${model_file}")
            message(FATAL_ERROR "Error downloading ${ARTIFACTORY_URL}/opencv/${model_file_name}")
        endif()
    elseif()
        message("${model_file_name} already exits")
    endif()
endforeach()

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
    ${OPENCV_ANALYTICS_PLUGIN_SRC_DIR})
set(CMAKE_EXE_LINKER_FLAGS " -static")
target_link_libraries(opencv_object_detection_analytics_plugin
    nx_kit
    nx_sdk
    opencv::core opencv::flann opencv::imgproc opencv::imgcodecs opencv::dnn opencv::opencv_dnn opencv::ml 
    opencv::plot opencv::opencv_features2d opencv::opencv_calib3d opencv::datasets opencv::video opencv::tracking
   -static-libgcc
   -static-libstdc++
)

target_compile_definitions(opencv_object_detection_analytics_plugin
    PRIVATE NX_PLUGIN_API=${API_EXPORT_MACRO}
)
