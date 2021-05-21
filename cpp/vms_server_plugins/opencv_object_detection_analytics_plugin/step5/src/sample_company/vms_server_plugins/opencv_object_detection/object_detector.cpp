// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#include "object_detector.h"

#include <opencv2/core.hpp>

#include "exceptions.h"
#include "frame.h"

namespace sample_company {
namespace vms_server_plugins {
namespace opencv_object_detection {

using namespace std::string_literals;

using namespace cv;
using namespace cv::dnn;

ObjectDetector::ObjectDetector(std::filesystem::path modelPath):
    m_modelPath(std::move(modelPath))
{
}

/**
 * Load the model if it is not loaded, do nothing otherwise. In case of errors terminate the
 * plugin and throw a specialized exception.
 */
void ObjectDetector::ensureInitialized()
{
    if (isTerminated())
    {
        throw ObjectDetectorIsTerminatedError(
            "Object detector initialization error: object detector is terminated.");
    }
    if (m_netLoaded)
        return;

    try
    {
        loadModel();
    }
    catch (const cv::Exception& e)
    {
        terminate();
        throw ObjectDetectorInitializationError("Loading model: " + cvExceptionToStdString(e));
    }
    catch (const std::exception& e)
    {
        terminate();
        throw ObjectDetectorInitializationError("Loading model: Error: "s + e.what());
    }
}

bool ObjectDetector::isTerminated() const
{
    return m_terminated;
}

void ObjectDetector::terminate()
{
    m_terminated = true;
}

DetectionList ObjectDetector::run(const Frame& frame)
{
    if (isTerminated())
        throw ObjectDetectorIsTerminatedError("Detection error: object detector is terminated.");

    try
    {
        return runImpl(frame);
    }
    catch (const cv::Exception& e)
    {
        terminate();
        throw ObjectDetectionError(cvExceptionToStdString(e));
    }
    catch (const std::exception& e)
    {
        terminate();
        throw ObjectDetectionError("Error: "s + e.what());
    }
}

//-------------------------------------------------------------------------------------------------
// private

void ObjectDetector::loadModel()
{
    // Prepare paths of model weights and definition.
    static const auto modelBin = m_modelPath /
        std::filesystem::path("MobileNetSSD.caffemodel");
    static const auto modelTxt = m_modelPath /
        std::filesystem::path("MobileNetSSD.prototxt");

    // Load the model for future processing using OpenCV.
    m_net = std::make_unique<Net>(
        readNetFromCaffe(modelTxt.string(), modelBin.string()));

    // Save the whether the net is loaded or not to prevent unnecessary load.
    m_netLoaded = !m_net->empty();

    if (!m_netLoaded)
        throw ObjectDetectorInitializationError("Loading model: network is empty.");
}

std::shared_ptr<Detection> convertRawDetectionToDetection(
    const Mat& rawDetections,
    int detectionIndex)
{
    enum class OutputIndex
    {
        classIndex = 1,
        confidence = 2,
        xBottomLeft = 3,
        yBottomLeft = 4,
        xTopRight = 5,
        yTopRight = 6,
    };
    static constexpr float confidenceThreshold = 0.5F; //< Chosen arbitrarily.

    const int& i = detectionIndex;
    const float confidence = rawDetections.at<float>(i, (int) OutputIndex::confidence);
    const auto classIndex = (int) (rawDetections.at<float>(i, (int) OutputIndex::classIndex));
    const std::string classLabel = kClasses[(size_t) classIndex];
    const bool confidentDetection = confidence >= confidenceThreshold;
    const bool oneOfRequiredClasses = std::find(
        kClassesToDetect.begin(), kClassesToDetect.end(), classLabel) != kClassesToDetect.end();
    if (confidentDetection && oneOfRequiredClasses)
    {
        const float xBottomLeft = rawDetections.at<float>(i, (int) OutputIndex::xBottomLeft);
        const float yBottomLeft = rawDetections.at<float>(i, (int) OutputIndex::yBottomLeft);
        const float xTopRight = rawDetections.at<float>(i, (int) OutputIndex::xTopRight);
        const float yTopRight = rawDetections.at<float>(i, (int) OutputIndex::yTopRight);
        const float width = xTopRight - xBottomLeft;
        const float height = yTopRight - yBottomLeft;

        return std::make_shared<Detection>(Detection{
            /*boundingBox*/ nx::sdk::analytics::Rect(xBottomLeft, yBottomLeft, width, height),
            classLabel,
            confidence,
            /*trackId*/ nx::sdk::Uuid() //< Will be filled with real value in ObjectTracker.
        });
    }
    return nullptr;
}

DetectionList ObjectDetector::runImpl(const Frame& frame)
{
    if (isTerminated())
    {
        throw ObjectDetectorIsTerminatedError(
            "Object detection error: object detector is terminated.");
    }

    const Mat image = frame.cvMat;

    // MobileNet SSD parameters.
    static const Size netInputImageSize(300, 300);
    static constexpr double scaleFactor = 1.0 / 127.5;
    static const Scalar mean(127.5, 127.5, 127.5);
    static constexpr int kHeightIndex = 2;
    static constexpr int kWidthIndex = 3;

    const Mat netInputBlob = blobFromImage(image, scaleFactor, netInputImageSize, mean);

    m_net->setInput(netInputBlob);
    Mat rawDetections = m_net->forward();
    const Mat detections(
        /*_rows*/ rawDetections.size[kHeightIndex],
        /*_cols*/ rawDetections.size[kWidthIndex],
        /*_type*/ CV_32F,
        /*_s*/ rawDetections.ptr<float>());

    DetectionList result;

    for (int i = 0; i < detections.rows; ++i)
    {
        const std::shared_ptr<Detection> detection = convertRawDetectionToDetection(detections, i);
        if (detection)
            result.push_back(detection);
    }

    return result;
}

} // namespace opencv_object_detection
} // namespace vms_server_plugins
} // namespace sample_company
