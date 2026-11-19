## Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

cmake_minimum_required(VERSION 3.28)
project(opencv_object_detection_analytics_plugin)

set(nxSdkVersion "6.1.3.43301")
set(nxSdkDir "" CACHE PATH
    "Path to unpacked VMS Server Plugin SDK zip. Tested with version ${nxSdkVersion}.")

# metadataSdkDir is the name used before SDK 6.1 (Metadata SDK); still accepted.
if(nxSdkDir STREQUAL "" AND NOT "${metadataSdkDir}" STREQUAL "")
    message(WARNING "metadataSdkDir is deprecated, use nxSdkDir instead.")
    set(nxSdkDir "${metadataSdkDir}" CACHE PATH "" FORCE)
endif()

if(NOT EXISTS "${nxSdkDir}/src/nx/sdk" OR NOT EXISTS "${nxSdkDir}/nx_kit/src/nx/kit")
    message(FATAL_ERROR "Define nxSdkDir cache variable to point to the unzipped SDK.")
endif()
if(NOT EXISTS "${nxSdkDir}/src/nx/sdk/analytics/helpers/integration.h")
    message(FATAL_ERROR "This plugin requires Server Plugin SDK 6.1 or later; "
        "the SDK in ${nxSdkDir} is older.")
endif()

if(NOT DEFINED ARTIFACTORY_URL)
    set(ARTIFACTORY_URL "https://artifactory.nxvms.dev/artifactory/artifacts/nx_open_integrations")
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

# On Linux, when compiling with Clang, optionally use libc++ linked statically instead of
# libstdc++, as recommended by the Server Plugin SDK (see src/nx/sdk/dynamic_libraries.md). Off by
# default: it needs a static libc++ built with -fPIC, which the libc++ packages of Ubuntu are not;
# libstdc++ works with any Clang (the Server itself uses it). Must be set before the compiler
# settings are passed to Conan.
if(CMAKE_SYSTEM_NAME STREQUAL "Linux" AND CMAKE_CXX_COMPILER_ID STREQUAL "Clang")
    option(useLibcxx "Use libc++ linked statically instead of libstdc++." OFF)
    if(useLibcxx)
        string(APPEND CMAKE_CXX_FLAGS " -stdlib=libc++")
        string(APPEND CMAKE_SHARED_LINKER_FLAGS " -stdlib=libc++ -static-libstdc++")
    endif()
endif()

#--------------------------------------------------------------------------------------------------
# Get OpenCV using Conan 1.x (cmake-conan).

list(APPEND CMAKE_MODULE_PATH ${CMAKE_BINARY_DIR})
list(APPEND CMAKE_PREFIX_PATH ${CMAKE_BINARY_DIR})

if(NOT EXISTS "${CMAKE_BINARY_DIR}/conan.cmake")
    message(STATUS "Downloading conan.cmake from ${ARTIFACTORY_URL}")
    file(DOWNLOAD "${ARTIFACTORY_URL}/conan.cmake" "${CMAKE_BINARY_DIR}/conan.cmake")
endif()
include(${CMAKE_BINARY_DIR}/conan.cmake)

conan_check(REQUIRED)
execute_process(COMMAND ${CONAN_CMD} --version OUTPUT_VARIABLE conanVersionOutput)
if(conanVersionOutput MATCHES "version 2\\.")
    message(FATAL_ERROR "Conan 2 is not supported; install Conan 1.x (see cpp/vms_server_plugins/scripts/provision_scripts/setup_conan.*).")
endif()

# Where to get OpenCV from (see readme.md):
# - opencvFromNx ON (default on Linux): the Nx Conan remote, with the OpenCV recipe that Nx uses,
#   protobuf (needed by the dnn module to load the model) and only the modules the plugin uses. The
#   Nx remote has no binaries of it yet, so Conan builds OpenCV and protobuf (from ConanCenter) from
#   source; this takes a few minutes and needs no system packages.
# - opencvFromNx OFF (default on Windows): ConanCenter, OpenCV prebuilt with its default options.
#   ConanCenter has no such binaries for GCC 13, so on Linux Conan would build all of OpenCV.
if(WIN32)
    set(opencvFromNxDefault OFF)
else()
    set(opencvFromNxDefault ON)
endif()
option(opencvFromNx "Get OpenCV from the Nx Conan remote instead of ConanCenter."
    ${opencvFromNxDefault})

# Both OpenCV references below pin a recipe revision, so Conan revisions must be enabled (the Nx
# remote requires them too). setup_conan.* enables them in the Conan config; this covers a Conan
# set up otherwise.
set(ENV{CONAN_REVISIONS_ENABLED} 1)

conan_add_remote(NAME conancenter URL https://center.conan.io)

if(opencvFromNx)
    conan_add_remote(NAME nx INDEX 0
        URL https://artifactory.nxvms.dev/artifactory/api/conan/conan)
    # Conan looks for updates of a package only in the remote it came from; if the Conan cache has
    # OpenCV from ConanCenter (built before with opencvFromNx off), make it use nx instead.
    execute_process(COMMAND ${CONAN_CMD} remote update_ref opencv/4.10.0@ nx
        OUTPUT_QUIET ERROR_QUIET)
    set(opencvReference "opencv/4.10.0@#381886e5d0949db615c809d7d8cc8619")
    set(opencvRemote "") #< OpenCV from nx, protobuf from conancenter.
    set(opencvOptions
        opencv:shared=False
        opencv:with_protobuf=True
        opencv:dnn=True
        opencv:calib3d=False
        opencv:features2d=False
        opencv:flann=False
        opencv:gapi=False
        opencv:highgui=False
        opencv:imgcodecs=False
        opencv:ml=False
        opencv:objdetect=False
        opencv:photo=False
        opencv:stitching=False
        opencv:video=False
        opencv:videoio=False
        opencv:with_eigen=False
        opencv:with_flatbuffers=False
        opencv:with_opencl=False
        opencv:with_ipp=False
        opencv:parallel=False
    )
    set(windowsCompilerVersion 17) #< Visual Studio 2022.
else()
    # OpenCV with its default options, for which ConanCenter has prebuilt binaries for some
    # compilers (any other option values make Conan build OpenCV from source). On Linux, the default
    # options need some system packages; see readme.md.
    set(opencvReference "opencv/4.10.0@#375c6f12ed7803970f0ec84298011dae")
    set(opencvRemote REMOTE conancenter)
    set(opencvOptions "")
    # ConanCenter has prebuilt OpenCV only for Visual Studio 2019. Static libraries built with it
    # link fine into a plugin built with Visual Studio 2022 (MSVC v14x toolsets are binary
    # compatible), so request those instead of building OpenCV from source.
    set(windowsCompilerVersion 16)
endif()

if(WIN32)
    if(CMAKE_BUILD_TYPE STREQUAL "Debug")
        set(opencvSettings build_type=Debug compiler.runtime=MDd)
    else()
        set(opencvSettings build_type=Release compiler.runtime=MD)
    endif()
    list(APPEND opencvSettings
        os=Windows arch=x86_64 "compiler=Visual Studio" compiler.version=${windowsCompilerVersion})
else()
    # Pass the settings of the current compiler to Conan; otherwise Conan uses its default profile,
    # which may describe a different compiler or C++ standard library.
    conan_cmake_autodetect(opencvSettings BUILD_TYPE Release)
    # ConanCenter builds its binaries without compiler.cppstd; with it, there would be no prebuilt
    # binaries for the C++ packages (OpenCV works with the plugin's C++17 code either way).
    # compiler.libcxx is set below: cmake-conan fails to detect libstdc++ with Clang.
    list(FILTER opencvSettings EXCLUDE REGEX "^compiler\\.(cppstd|libcxx)=")
    if(useLibcxx)
        list(APPEND opencvSettings "compiler.libcxx=libc++")
    else()
        list(APPEND opencvSettings "compiler.libcxx=libstdc++11")
    endif()
endif()

# UPDATE: the Conan cache keeps one recipe revision of a package, so switching opencvFromNx
# requires fetching the other pinned revision.
conan_cmake_install(PATH_OR_REFERENCE ${opencvReference}
    ${opencvRemote}
    UPDATE
    SETTINGS ${opencvSettings}
    OPTIONS ${opencvOptions}
    BUILD missing
    GENERATOR cmake_find_package
)

# Use the FindOpenCV.cmake generated by Conan (in CMAKE_BINARY_DIR), never an OpenCV installed in
# the system.
find_package(OpenCV REQUIRED MODULE)

#--------------------------------------------------------------------------------------------------
# Download model files.

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
            "${ARTIFACTORY_URL}/opencv_object_detection_analytics_plugin/models/${model_file_name}"
            "${model_file}"
            SHOW_PROGRESS
            STATUS DOWNLOAD_STATUS
        )
        list(GET DOWNLOAD_STATUS 0 STATUS_CODE)
        if(NOT STATUS_CODE EQUAL 0)
            file(REMOVE "${model_file}")
            message(FATAL_ERROR "Error downloading ${ARTIFACTORY_URL}/opencv_object_detection_analytics_plugin/models/${model_file_name}")
        endif()
    else()
        message("${model_file_name} already exists")
    endif()
endforeach()

#--------------------------------------------------------------------------------------------------
# Define nx_kit lib, static.

set(nxKitLibraryType "STATIC" CACHE STRING "" FORCE)
set(nxKitWithTests "NO" CACHE STRING "" FORCE)

add_subdirectory(${nxSdkDir}/nx_kit ${CMAKE_CURRENT_BINARY_DIR}/nx_kit)

#--------------------------------------------------------------------------------------------------
# Define nx_sdk lib, static, depends on nx_kit.

set(SDK_SRC_DIR ${nxSdkDir}/src)
file(GLOB_RECURSE SDK_SRC ${SDK_SRC_DIR}/*)

add_library(nx_sdk STATIC ${SDK_SRC})
target_include_directories(nx_sdk PUBLIC ${SDK_SRC_DIR})
target_link_libraries(nx_sdk PRIVATE nx_kit)

target_compile_definitions(nx_sdk PRIVATE NX_PLUGIN_API=${API_EXPORT_MACRO})

#--------------------------------------------------------------------------------------------------
# Define opencv_object_detection_analytics_plugin lib, dynamic, depends on nx_kit, nx_sdk and
# OpenCV.

set(OPENCV_OBJECT_DETECTION_ANALYTICS_PLUGIN_SRC_DIR ${CMAKE_CURRENT_LIST_DIR}/src)
file(GLOB_RECURSE OPENCV_OBJECT_DETECTION_ANALYTICS_PLUGIN_SRC
    ${OPENCV_OBJECT_DETECTION_ANALYTICS_PLUGIN_SRC_DIR}/*)

add_library(opencv_object_detection_analytics_plugin SHARED
    ${OPENCV_OBJECT_DETECTION_ANALYTICS_PLUGIN_SRC})
target_include_directories(opencv_object_detection_analytics_plugin PRIVATE
    ${OPENCV_OBJECT_DETECTION_ANALYTICS_PLUGIN_SRC_DIR})
target_link_libraries(opencv_object_detection_analytics_plugin PRIVATE
    nx_kit
    nx_sdk
    opencv::opencv_core
    opencv::opencv_imgproc
    opencv::opencv_dnn
)

target_compile_definitions(opencv_object_detection_analytics_plugin
    PRIVATE NX_PLUGIN_API=${API_EXPORT_MACRO}
)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    # Export only the entry points the Server looks up, hiding the symbols of the statically linked
    # libraries (OpenCV and its dependencies) - see src/nx/sdk/dynamic_libraries.md in the SDK.
    set(exportsMapFile "${CMAKE_CURRENT_BINARY_DIR}/exports.map")
    file(WRITE ${exportsMapFile}
        "{ global: createNxPlugin; nxLibContext; nxSdkVersion; nxSetUnitTestOptions; local: *; };\n")
    target_link_options(opencv_object_detection_analytics_plugin PRIVATE
        "LINKER:--version-script=${exportsMapFile}"
        "LINKER:--no-undefined"
    )
endif()
