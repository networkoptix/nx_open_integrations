## Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

# Defines opencv_tbm, a static library with OpenCV Tracking-by-Matching; see readme.md. Requires
# find_package(OpenCV) to have been called.

file(GLOB OPENCV_TBM_SRC ${CMAKE_CURRENT_LIST_DIR}/src/*)

add_library(opencv_tbm STATIC ${OPENCV_TBM_SRC})
target_include_directories(opencv_tbm PUBLIC ${CMAKE_CURRENT_LIST_DIR}/include)
target_link_libraries(opencv_tbm PUBLIC opencv::opencv_core opencv::opencv_imgproc)
