
list(APPEND CMAKE_MODULE_PATH ${CMAKE_BINARY_DIR})
list(APPEND CMAKE_PREFIX_PATH ${CMAKE_BINARY_DIR})

if(NOT DEFINED ARTIFACTORY_URL)
    set(ARTIFACTORY_URL "https://artifactory.nxvms.dev/artifactory/artifacts/nx_open_integrations")
endif()

if(NOT EXISTS "${CMAKE_BINARY_DIR}/conan.cmake")
    message(STATUS "Downloading conan.cmake from ${ARTIFACTORY_URL}")
    file(DOWNLOAD ${ARTIFACTORY_URL}/conan.cmake "${CMAKE_BINARY_DIR}/conan.cmake")
    
    # message(STATUS "Downloading conan.cmake from https://github.com/conan-io/cmake-conan")
    # file(DOWNLOAD "https://raw.githubusercontent.com/conan-io/cmake-conan/master/conan.cmake"
    #    "${CMAKE_BINARY_DIR}/conan.cmake")
endif()
include(${CMAKE_BINARY_DIR}/conan.cmake)

#
# checking conan version. v2.0 is NOT supported
#
conan_check(REQUIRED)
execute_process(
    COMMAND ${CONAN_CMD} --version
    OUTPUT_VARIABLE CONAN_VERSION_OUTPUT
    OUTPUT_STRIP_TRAILING_WHITESPACE
)
string(REGEX MATCH "([0-9]+)\\.([0-9]+)\\.([0-9]+)" CONAN_VERSION ${CONAN_VERSION_OUTPUT})

if (CONAN_VERSION MATCHES "^2\\.")
    message(FATAL_ERROR "Using Conan 2.x is not supported")
endif()

include(${CMAKE_CURRENT_LIST_DIR}/cmake/default_target.cmake)
set(targetDevice ${default_target_device} CACHE STRING
     "Target device. For the list see cmake/toolchains.")

set(conan_profile ${targetDevice})
if(targetDevice STREQUAL edge1)
    set(conan_profile linux_arm32)
elseif(targetDevice MATCHES "^windows")
    if(CMAKE_BUILD_TYPE STREQUAL "Debug")
        set(conan_profile "${targetDevice}_debug")
    else()
        set(conan_profile "${targetDevice}_release")
    endif()
endif()

set(conanNxRemote http://artifactory.nxvms.dev/artifactory/api/conan/conan
    CACHE INTERNAL "The URL of Conan remote containing packages needed for the build."
)

execute_process(
    COMMAND ${CONAN_CMD} remote add nx ${conanNxRemote}
)

if(UNIX)
    file(STRINGS "${CMAKE_CURRENT_LIST_DIR}/cmake/conan_profiles/gcc.profile" TOOLCHAIN_STRING REGEX "^gcc-toolchain")
    string(REGEX REPLACE "#.*" "" TOOLCHAIN_VERSION ${TOOLCHAIN_STRING})
    message(STATUS "Version: ${TOOLCHAIN_VERSION}")

    conan_cmake_install(PATH_OR_REFERENCE ${TOOLCHAIN_VERSION}@
        REMOTE nx
        OUTPUT_FOLDER ${CMAKE_BINARY_PATH}
        OPTIONS "target_arch=x86_64"
    )
    message(STATUS "Running process: COMMAND ${CONAN_CMD} info ${TOOLCHAIN_VERSION}@ -o target_arch=x86_64 --paths")
    execute_process(
        COMMAND ${CONAN_CMD} info ${TOOLCHAIN_VERSION}@ -o target_arch=x86_64 --paths
        OUTPUT_VARIABLE _conan_info_out
        ERROR_VARIABLE  _conan_info_err
        RESULT_VARIABLE _conan_info_ret
        OUTPUT_STRIP_TRAILING_WHITESPACE
    )
    
    message(STATUS ${_conan_info_out})

    if(NOT _conan_info_ret EQUAL 0)
        message(FATAL_ERROR "conan info failed:\n${_conan_info_err}")
    endif()

    # Find a string "package_folder: /path"
    string(REGEX MATCH "package_folder: ([^\r\n]+)" _match "${_conan_info_out}")

    if(CMAKE_MATCH_1 EQUAL "")
        message(FATAL_ERROR "Package folder not found in conan info output. Output:\n${_conan_info_out}")
    endif()

    set(TOOLCHAIN_DIR ${CMAKE_MATCH_1})
    message(STATUS "toolchain package_folder: ${TOOLCHAIN_DIR}")

endif()

if(NOT CMAKE_TOOLCHAIN_FILE AND targetDevice)
    if(EXISTS ${CMAKE_CURRENT_LIST_DIR}/cmake/toolchain/${targetDevice}.cmake)
        set(CMAKE_TOOLCHAIN_FILE ${CMAKE_CURRENT_LIST_DIR}/cmake/toolchain/${targetDevice}.cmake)
    else()
        set(CMAKE_TOOLCHAIN_FILE
            ${CMAKE_CURRENT_LIST_DIR}/open/cmake/toolchain/${targetDevice}.cmake)
    endif()

    if(NOT EXISTS ${CMAKE_TOOLCHAIN_FILE})
        unset(CMAKE_TOOLCHAIN_FILE)
    endif()
endif()

set(ENV{TOOLCHAIN_DIR} ${TOOLCHAIN_DIR})
