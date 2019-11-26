// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#pragma once

#include <stdexcept>

#include <opencv2/core/core.hpp>

namespace sample_company {
namespace vms_server_plugins {
namespace opencv_object_detection {

class Error: public std::runtime_error { using std::runtime_error::runtime_error; };

class ObjectDetectorError: public Error { using Error::Error; };

class ObjectDetectorInitializationError: public ObjectDetectorError
    { using ObjectDetectorError::ObjectDetectorError; };

class ObjectDetectorIsTerminatedError: public ObjectDetectorError
    { using ObjectDetectorError::ObjectDetectorError; };

class ObjectDetectionError: public ObjectDetectorError
    { using ObjectDetectorError::ObjectDetectorError; };

class ObjectTrackerError: public Error { using Error::Error; };

class ObjectTrackingError: public ObjectTrackerError
    { using ObjectTrackerError::ObjectTrackerError; };

inline std::string cvExceptionToStdString(const cv::Exception& e)
{
    return "OpenCV error: " + e.err + " (error code: " + std::to_string(e.code) + ")";
}

} // namespace opencv_object_detection
} // namespace vms_server_plugins
} // namespace sample_company
