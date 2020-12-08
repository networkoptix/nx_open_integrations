// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#pragma once

#include <stdexcept>

#include <opencv2/core/core.hpp>

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

using namespace std::string_literals;

class Error: public std::runtime_error { using std::runtime_error::runtime_error; };

class CpuIsIncompatibleError: public Error { using Error::Error; };

class PluginLoadingError: public Error { using Error::Error; };

class ModelLoadingError: public PluginLoadingError
    { using PluginLoadingError::PluginLoadingError; };

class InferenceError: public Error { using Error::Error; };

class ObjectDetectorError: public Error { using Error::Error; };

class ObjectDetectionError: public ObjectDetectorError
    { using ObjectDetectorError::ObjectDetectorError; };

class ObjectTrackerError: public Error { using Error::Error; };

class ObjectTrackingError: public ObjectTrackerError
    { using ObjectTrackerError::ObjectTrackerError; };

class RoiError: public Error { using Error::Error; };

class FrameProcessingError: public Error { using Error::Error; };

inline std::string cvExceptionToStdString(const cv::Exception& e)
{
    return "OpenCV error: "s + e.err + " (error code: " + std::to_string(e.code) + ")";
}

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
