// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#pragma once

#include <opencv2/core/core.hpp>

#include <nx/sdk/analytics/i_uncompressed_video_frame.h>

namespace sample_company {
namespace vms_server_plugins {
namespace opencv_object_detection {

/**
 * Stores frame data and cv::Mat. Note, there is no copying of image data in the constructor.
 */
struct Frame
{
    const int width;
    const int height;
    const int64_t timestampUs;
    const int64_t index;
    const cv::Mat cvMat;

public:
    Frame(const nx::sdk::analytics::IUncompressedVideoFrame* frame, int64_t index):
        width(frame->width()),
        height(frame->height()),
        timestampUs(frame->timestampUs()),
        index(index),
        cvMat({
            /*_rows*/ height,
            /*_cols*/ width,
            /*_type*/ CV_8UC3, //< BGR color space (default for OpenCV).
            /*_data*/ (void*) frame->data(0),
            /*_step*/ (size_t) frame->lineSize(0),
        })
    {
    }
};

} // namespace opencv_object_detection
} // namespace vms_server_plugins
} // namespace sample_company
