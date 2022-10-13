// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#pragma once

#include <opencv2/core/core.hpp>
#include <opencv2/imgproc.hpp>

#include <nx/sdk/analytics/i_uncompressed_video_frame.h>
#include <nx/kit/debug.h>

extern "C" {
#ifdef WIN32
#   define AVPixFmtDescriptor __declspec(dllimport) AVPixFmtDescriptor
#endif
#include <libavutil/pixdesc.h>
#include <libswscale/swscale.h>
#include <libavutil/imgutils.h>
#ifdef WIN32
#   undef AVPixFmtDescriptor
#endif
};

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
    cv::Mat cvMat;

public:
    Frame(const nx::sdk::analytics::IUncompressedVideoFrame* frame, int64_t index):      
        width(frame->width()),
        height(frame->height()),
        timestampUs(frame->timestampUs()),
        index(index)
    {
        
        int srcLineSize[AV_NUM_DATA_POINTERS];
        const uint8_t * srcData[AV_NUM_DATA_POINTERS];
        int cvLineSizes[AV_NUM_DATA_POINTERS];
        if (frame->pixelFormat() == nx::sdk::analytics::IUncompressedVideoFrame::PixelFormat::yuv420)
        {
            for (int i = 0; i < frame->planeCount(); i++)
            {
                srcLineSize[i] = frame->lineSize(i);
                srcData[i] = (const uint8_t*) frame->data(i);     
            }
            
            // to make ffmpeg not to process beyond the planeCount
            srcLineSize[frame->planeCount()] = 0;
            srcData[frame->planeCount()] = 0;
        
            cvLineSizes[1] = 0;
            cvMat = cv::Mat(height, width, CV_8UC3);
            cvLineSizes[0] = cvMat.step1();
            SwsContext* conversion = sws_getContext(width, height, AV_PIX_FMT_YUV420P,
                                                    width, height, AV_PIX_FMT_BGR24,
                                                    SWS_FAST_BILINEAR, NULL, NULL, NULL);
            sws_scale(conversion, srcData, srcLineSize, 0, height, &cvMat.data, cvLineSizes);
            sws_freeContext(conversion);
        } else if (frame->pixelFormat() == nx::sdk::analytics::IUncompressedVideoFrame::PixelFormat::bgr) {
            cvMat = cv::Mat(
            /*_rows*/ frame->height(),
            /*_cols*/ frame->width(),
            /*_type*/ CV_8UC3, //< BGR color space (default for OpenCV).
            /*_data*/ (void*) frame->data(0),
            /*_step*/ (size_t) frame->lineSize(0));
        }
        
    }
};

} // namespace opencv_object_detection
} // namespace vms_server_plugins
} // namespace sample_company
