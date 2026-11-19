## Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

# run_plugin: loads an analytics plugin and feeds it video frames; see run_plugin.cpp.

cmake_minimum_required(VERSION 3.28)
project(run_plugin CXX)

set(nxSdkDir "" CACHE PATH "Path to the unpacked Server Plugin SDK.")
if(NOT EXISTS "${nxSdkDir}/src/nx/sdk" OR NOT EXISTS "${nxSdkDir}/nx_kit/src/nx/kit")
    message(FATAL_ERROR "Define nxSdkDir cache variable to point to the unzipped SDK.")
endif()

set(CMAKE_CXX_STANDARD 17)

set(nxKitLibraryType "STATIC" CACHE STRING "" FORCE)
set(nxKitWithTests "NO" CACHE STRING "" FORCE)
add_subdirectory(${nxSdkDir}/nx_kit ${CMAKE_BINARY_DIR}/nx_kit)

file(GLOB_RECURSE sdkSources CONFIGURE_DEPENDS ${nxSdkDir}/src/*.cpp)
add_executable(run_plugin run_plugin.cpp ${sdkSources})
target_include_directories(run_plugin PRIVATE ${nxSdkDir}/src)
target_compile_definitions(run_plugin PRIVATE NX_PLUGIN_API=)
target_link_libraries(run_plugin PRIVATE nx_kit ${CMAKE_DL_LIBS})
