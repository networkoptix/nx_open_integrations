## Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

cmake_minimum_required(VERSION 3.16)
project(openvino_object_detection_analytics_plugin)

set(THREADS_PREFER_PTHREAD_FLAG ON)
find_package(Threads REQUIRED)

set(metadataSdkDir "" CACHE PATH "Path to unpacked VMS Metadata SDK zip.")
if(metadataSdkDir STREQUAL ""
    OR NOT EXISTS ${metadataSdkDir}/src/nx/sdk
    OR NOT EXISTS ${metadataSdkDir}/nx_kit/src/nx/kit
)
    message(FATAL_ERROR "Define metadataSdkDir cache variable to point to the unzipped SDK.")
endif()

find_package(Boost REQUIRED)
find_package(InferenceEngine REQUIRED)
find_package(OpenCV REQUIRED core imgcodecs imgproc)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_EXTENSIONS OFF)

set(CMAKE_CXX_VISIBILITY_PRESET hidden)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(UNIX)
    # In Linux, for the plugin .so library and app, set `rpath` to "$ORIGIN" and do not set
    # `runpath`, thus enabling the lookup of the dependencies in the plugin dir first.
    string(APPEND CMAKE_SHARED_LINKER_FLAGS " -Wl,--disable-new-dtags")
    string(APPEND CMAKE_EXE_LINKER_FLAGS " -Wl,--disable-new-dtags")
endif()
set(CMAKE_SKIP_BUILD_RPATH ON)
set(CMAKE_BUILD_WITH_INSTALL_RPATH ON)
set(CMAKE_INSTALL_RPATH "$ORIGIN")

if(WIN32)
    set(API_IMPORT_MACRO "__declspec(dllimport)")
    set(API_EXPORT_MACRO "__declspec(dllexport)")
elseif(UNIX)
    set(API_IMPORT_MACRO "")
    set(API_EXPORT_MACRO "__attribute__((visibility(\"default\")))")
endif()

#--------------------------------------------------------------------------------------------------
# Define opencv_tbm lib, static.

set(OPENCV_TBM_SRC_DIR ${CMAKE_CURRENT_LIST_DIR}/src/opencv_tbm)
file(GLOB_RECURSE OPENCV_TBM_SRC ${OPENCV_TBM_SRC_DIR}/*)

add_library(opencv_tbm STATIC ${OPENCV_TBM_SRC})

target_include_directories(opencv_tbm PRIVATE ${OpenCV_INCLUDE_DIRS})

#--------------------------------------------------------------------------------------------------
# Define nx_kit lib, static.

set(nxKitLibraryType "STATIC" CACHE STRING "" FORCE)
set(nxKitWithTests "YES" CACHE STRING "" FORCE)

add_subdirectory(${metadataSdkDir}/nx_kit ${CMAKE_CURRENT_BINARY_DIR}/nx_kit)

#--------------------------------------------------------------------------------------------------
# Define nx_sdk lib, static, depends on nx_kit.

set(SDK_SRC_DIR "${metadataSdkDir}/src")
file(GLOB_RECURSE SDK_SRC "${SDK_SRC_DIR}/*")

add_library(nx_sdk STATIC ${SDK_SRC})
target_include_directories(nx_sdk PUBLIC ${SDK_SRC_DIR})
target_link_libraries(nx_sdk PRIVATE nx_kit)

target_compile_definitions(nx_sdk PRIVATE NX_PLUGIN_API=${API_EXPORT_MACRO})

#--------------------------------------------------------------------------------------------------
# Define common variables.

set(OPENVINO_OBJECT_DETECTION_ANALYTICS_PLUGIN_SRC_DIR ${CMAKE_CURRENT_LIST_DIR}/src)
file(GLOB_RECURSE OPENVINO_OBJECT_DETECTION_ANALYTICS_PLUGIN_APP_SRC
    ${OPENVINO_OBJECT_DETECTION_ANALYTICS_PLUGIN_SRC_DIR}/app/*)
file(GLOB_RECURSE OPENVINO_OBJECT_DETECTION_ANALYTICS_PLUGIN_LIB_SRC
    ${OPENVINO_OBJECT_DETECTION_ANALYTICS_PLUGIN_SRC_DIR}/lib/*)
file(GLOB_RECURSE OPENVINO_OBJECT_DETECTION_ANALYTICS_PLUGIN_PLUGIN_SRC
    ${OPENVINO_OBJECT_DETECTION_ANALYTICS_PLUGIN_SRC_DIR}/plugin/*)

set(OPENVINO_OBJECT_DETECTION_ANALYTICS_PLUGIN_INCLUDE_DIRECTORIES
    ${OPENVINO_OBJECT_DETECTION_ANALYTICS_PLUGIN_SRC_DIR}
    ${CPUID_SRC_DIR}
    ${OPENCV_TBM_SRC_DIR}
)
set(OPENVINO_OBJECT_DETECTION_ANALYTICS_PLUGIN_LINK_LIBRARIES
    nx_kit
    nx_sdk
    Boost::boost
    IE::inference_engine
    IE::inference_engine_c_api
    IE::inference_engine_nn_builder
    opencv_core
    opencv_imgcodecs
    opencv_imgproc
    opencv_tbm
    $<$<AND:$<CXX_COMPILER_ID:GNU>,$<VERSION_LESS:$<CXX_COMPILER_VERSION>,9>>:stdc++fs>
    Threads::Threads
)
set(OPENVINO_OBJECT_DETECTION_ANALYTICS_PLUGIN_LINK_LIBRARIES_UNIX dl)

#--------------------------------------------------------------------------------------------------
# Define openvino_object_detection_analytics_plugin lib, dynamic, depends on nx_kit and nx_sdk.

add_library(openvino_object_detection_analytics_plugin SHARED
    ${OPENVINO_OBJECT_DETECTION_ANALYTICS_PLUGIN_LIB_SRC}
    ${OPENVINO_OBJECT_DETECTION_ANALYTICS_PLUGIN_PLUGIN_SRC}
)
target_include_directories(openvino_object_detection_analytics_plugin PRIVATE 
    ${OPENVINO_OBJECT_DETECTION_ANALYTICS_PLUGIN_INCLUDE_DIRECTORIES})
target_link_libraries(openvino_object_detection_analytics_plugin PRIVATE 
    ${OPENVINO_OBJECT_DETECTION_ANALYTICS_PLUGIN_LINK_LIBRARIES})
if(UNIX)
    target_link_libraries(openvino_object_detection_analytics_plugin PRIVATE 
        ${OPENVINO_OBJECT_DETECTION_ANALYTICS_PLUGIN_LINK_LIBRARIES_UNIX})
endif()

target_compile_definitions(openvino_object_detection_analytics_plugin
    PRIVATE NX_PLUGIN_API=${API_EXPORT_MACRO}
    INTERFACE NX_PLUGIN_API=${API_IMPORT_MACRO}
)

#--------------------------------------------------------------------------------------------------
# Define openvino_object_detection_analytics_plugin_app application, depends on nx_kit and nx_sdk.

find_package(OpenCV REQUIRED core highgui imgproc videoio)

add_executable(openvino_object_detection_analytics_plugin_app EXCLUDE_FROM_ALL
    ${OPENVINO_OBJECT_DETECTION_ANALYTICS_PLUGIN_LIB_SRC}
    ${OPENVINO_OBJECT_DETECTION_ANALYTICS_PLUGIN_APP_SRC}
)
target_include_directories(openvino_object_detection_analytics_plugin_app PRIVATE 
    ${OPENVINO_OBJECT_DETECTION_ANALYTICS_PLUGIN_INCLUDE_DIRECTORIES})
target_link_libraries(openvino_object_detection_analytics_plugin_app PRIVATE 
    ${OPENVINO_OBJECT_DETECTION_ANALYTICS_PLUGIN_LINK_LIBRARIES}
    opencv_highgui
    opencv_videoio
)
if(UNIX)
    target_link_libraries(openvino_object_detection_analytics_plugin_app PRIVATE 
        ${OPENVINO_OBJECT_DETECTION_ANALYTICS_PLUGIN_LINK_LIBRARIES_UNIX})
endif()

target_compile_definitions(openvino_object_detection_analytics_plugin_app
    PRIVATE NX_PLUGIN_API=${API_EXPORT_MACRO}
    INTERFACE NX_PLUGIN_API=${API_IMPORT_MACRO}
)

#--------------------------------------------------------------------------------------------------
# Build distribution.

set(distrib_name openvino_object_detection_analytics_plugin)
set(distrib_dir "${CMAKE_CURRENT_BINARY_DIR}/${distrib_name}") #< Stage for .zip content.
set(openvino_object_detection_analytics_plugin_zip_file_name "${distrib_name}.zip" CACHE STRING "")
set(zip_file "${CMAKE_CURRENT_BINARY_DIR}/${openvino_object_detection_analytics_plugin_zip_file_name}")

set(openvinoDir "${InferenceEngine_INCLUDE_DIRS}/../../..")

if(CMAKE_SYSTEM_NAME STREQUAL "Windows")
    set(intelSharedLibsDir
        "$ENV{COMMONPROGRAMFILES\(x86\)}/Intel/Shared Libraries"
        CACHE PATH "")

    set(openvino_files
        "${openvinoDir}/opencv/bin/opencv_core420$<$<CONFIG:Debug>:d>.dll"
        "${openvinoDir}/opencv/bin/opencv_imgcodecs420$<$<CONFIG:Debug>:d>.dll"
        "${openvinoDir}/opencv/bin/opencv_imgproc420$<$<CONFIG:Debug>:d>.dll"
        "${openvinoDir}/deployment_tools/inference_engine/bin/intel64/$<IF:$<CONFIG:Debug>,Debug,Release>/plugins.xml"
        "${openvinoDir}/deployment_tools/inference_engine/bin/intel64/$<IF:$<CONFIG:Debug>,Debug,Release>/MKLDNNPlugin$<$<CONFIG:Debug>:d>.dll"
        "${openvinoDir}/deployment_tools/ngraph/lib/ngraph$<$<CONFIG:Debug>:d>.dll"
        "${openvinoDir}/deployment_tools/inference_engine/bin/intel64/$<IF:$<CONFIG:Debug>,Debug,Release>/mkl_tiny_tbb$<$<CONFIG:Debug>:_debug>.dll"
        "${openvinoDir}/deployment_tools/inference_engine/external/tbb/bin/tbb$<$<CONFIG:Debug>:_debug>.dll"
        "${openvinoDir}/deployment_tools/inference_engine/external/tbb/bin/tbbmalloc$<$<CONFIG:Debug>:_debug>.dll"
        "${openvinoDir}/deployment_tools/inference_engine/bin/intel64/$<IF:$<CONFIG:Debug>,Debug,Release>/inference_engine$<$<CONFIG:Debug>:d>.dll"
        "${openvinoDir}/deployment_tools/inference_engine/bin/intel64/$<IF:$<CONFIG:Debug>,Debug,Release>/inference_engine_c_api$<$<CONFIG:Debug>:d>.dll"
        "${openvinoDir}/deployment_tools/inference_engine/bin/intel64/$<IF:$<CONFIG:Debug>,Debug,Release>/inference_engine_nn_builder$<$<CONFIG:Debug>:d>.dll"
        "${intelSharedLibsDir}/redist/intel64_win/compiler/libmmd$<$<CONFIG:Debug>:d>.dll"
        "${intelSharedLibsDir}/redist/intel64_win/compiler/svml_dispmd.dll"
    )

    set(fix_rpath_commands)
else()
    set(openvino_files
        "${openvinoDir}/opencv/lib/libopencv_core.so.4.2"
        "${openvinoDir}/opencv/lib/libopencv_imgcodecs.so.4.2"
        "${openvinoDir}/opencv/lib/libopencv_imgproc.so.4.2"
        "${openvinoDir}/deployment_tools/inference_engine/lib/intel64/plugins.xml"
        "${openvinoDir}/deployment_tools/inference_engine/lib/intel64/libMKLDNNPlugin.so"
        "${openvinoDir}/deployment_tools/ngraph/lib/libngraph.so"
        "${openvinoDir}/deployment_tools/inference_engine/external/mkltiny_lnx/lib/libmkl_tiny_tbb.so"
        "${openvinoDir}/deployment_tools/inference_engine/external/tbb/lib/libtbb.so.2"
        "${openvinoDir}/deployment_tools/inference_engine/external/tbb/lib/libtbbmalloc.so.2"
        "${openvinoDir}/deployment_tools/inference_engine/lib/intel64/libinference_engine.so"
        "${openvinoDir}/deployment_tools/inference_engine/lib/intel64/libinference_engine_c_api.so"
        "${openvinoDir}/deployment_tools/inference_engine/lib/intel64/libinference_engine_nn_builder.so"
    )

    set(fix_rpath_commands
        COMMAND patchelf --remove-rpath "${distrib_dir}/libMKLDNNPlugin.so"
        COMMAND patchelf --force-rpath --set-rpath "$ORIGIN" "${distrib_dir}/libMKLDNNPlugin.so"
    )
endif()

set(model_file_names
    pedestrian-and-vehicle-detector-adas-0001.bin
    pedestrian-and-vehicle-detector-adas-0001.labels
    pedestrian-and-vehicle-detector-adas-0001.xml
    person-reidentification-retail-0031.bin
    person-reidentification-retail-0031.xml
)

message("Downloading model files:")
foreach(model_file_name IN LISTS model_file_names)
    set(model_file "${CMAKE_BINARY_DIR}/${model_file_name}")
    list(APPEND model_files "${model_file}")
    if(NOT EXISTS "${model_file}")
        file(DOWNLOAD
            "https://resources.vmsproxy.com/nx_open_integrations/openvino/${model_file_name}"
            "${model_file}"
            SHOW_PROGRESS
        )
    endif()
endforeach()

add_custom_command(OUTPUT "${zip_file}"
    COMMAND "${CMAKE_COMMAND}" -E remove_directory "${distrib_dir}"
    COMMAND "${CMAKE_COMMAND}" -E make_directory "${distrib_dir}"

    COMMAND "${CMAKE_COMMAND}" -E
        copy "$<TARGET_FILE:openvino_object_detection_analytics_plugin>" "${distrib_dir}"
        
    COMMAND "${CMAKE_COMMAND}" -E copy ${openvino_files} "${distrib_dir}"

    ${fix_rpath_commands}

    COMMAND "${CMAKE_COMMAND}" -E copy ${model_files} "${distrib_dir}"

    COMMAND "${CMAKE_COMMAND}" -E tar cvf "${zip_file}" --format=zip "${distrib_dir}"
    COMMAND "${CMAKE_COMMAND}" -E remove_directory "${distrib_dir}"

    WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}" #< Needed for tar.
    DEPENDS openvino_object_detection_analytics_plugin
    VERBATIM
)

add_custom_target(openvino_object_detection_analytics_plugin_zip ALL DEPENDS ${zip_file})
