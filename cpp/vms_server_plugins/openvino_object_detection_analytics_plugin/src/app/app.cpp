// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#include "app.h"

#include <chrono>
#include <iomanip>
#include <sstream>

#include <opencv2/highgui.hpp>
#include <opencv2/imgproc.hpp>

#define NX_PRINT_PREFIX (this->logUtils.printPrefix)
#define NX_DEBUG_ENABLE_OUTPUT (this->logUtils.enableOutput)
#include <nx/kit/debug.h>
#include <nx/sdk/analytics/helpers/object_metadata.h>
#include <nx/sdk/helpers/uuid_helper.h>

#include "lib/frame.h"

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

using namespace std::chrono;

using namespace nx::sdk;
using namespace nx::sdk::analytics;

App::App(std::filesystem::path inputFile, std::filesystem::path modelDir):
    logUtils(/*enableOutput*/ true, /*printPrefix*/ ""),
    m_inputFile(std::move(inputFile)),
    m_modelDir(std::move(modelDir))
{
    using namespace std::string_literals;

    m_personDetector = std::make_unique<ObjectDetectionProcessor>(m_modelDir, logUtils);

    if (!m_videoInput.open(m_inputFile.string()))
        throw std::runtime_error("Failed to open '"s + m_inputFile.string() + "'."s);

    m_width = (int) m_videoInput.get(cv::CAP_PROP_FRAME_WIDTH);
    m_height = (int) m_videoInput.get(cv::CAP_PROP_FRAME_HEIGHT);
}

void App::run()
{
    cv::Mat cvFrame = readFrame();
    cv::imshow(m_windowName, cvFrame);
    cv::setMouseCallback(m_windowName, onMouse, m_drawingData.get());
    int64_t frameIndex = 0;
    static const int detectionPeriod = 1;
    for (;;)
    {
        if (cvFrame.empty())
            break;
        if (m_drawingData->lineIsUpdated)
            updateConfig();
        const int64_t timestampUs = duration_cast<microseconds>(
            system_clock::now().time_since_epoch()).count();
        const Frame frame(cvFrame, timestampUs, frameIndex);
        const bool needToDetectObjects = frameIndex % detectionPeriod == 0;
        const auto result = m_personDetector->run(frame, needToDetectObjects);
        render(cvFrame, timestampUs, result);
        cvFrame = readFrame();
        ++frameIndex;
    }
}

//-------------------------------------------------------------------------------------------------
// private

void App::onMouse(int event, int x, int y, int /*flags*/, void* userData) noexcept
{
    auto drawingData = static_cast<DrawingData*>(userData);
    switch (event)
    {
        case cv::EVENT_LBUTTONDOWN:
            drawingData->clicked = true;
            drawingData->lineIsDrawn = true;
            drawingData->p0.x = x;
            drawingData->p0.y = y;
            drawingData->p1.x = x;
            drawingData->p1.y = y;
            break;
        case cv::EVENT_MOUSEMOVE:
            if (drawingData->clicked)
            {
                drawingData->p1.x = x;
                drawingData->p1.y = y;
            }
            break;
        case cv::EVENT_LBUTTONUP:
            drawingData->clicked = false;
            drawingData->lineIsUpdated = true;
            break;
    }
}

void App::drawLine(cv::Mat frame) noexcept
{
    static const cv::Scalar kGreenColor = cv::Scalar(0, 255, 0);
    if (m_drawingData->lineIsDrawn)
        cv::line(frame, m_drawingData->p0, m_drawingData->p1, kGreenColor);
}

cv::Mat App::readFrame() noexcept
{
    try
    {
        return readFrameImpl();
    }
    catch (const std::exception& e)
    {
        NX_OUTPUT << "Error reading video frame: " << e.what();
        return {};
    }
    catch (...)
    {
        NX_OUTPUT << "Error reading video frame.";
        return {};
    }
}

cv::Mat App::readFrameImpl()
{
    cv::Mat result;
    m_videoInput >> result;
    if (result.empty())
        NX_OUTPUT << "Video has been finished.";
    return result;
}

void App::render(
    cv::Mat frame,
    int64_t timestampUs,
    const ObjectDetectionProcessor::Result& personDetectionResult) noexcept
{
    try
    {
        renderImpl(frame, timestampUs, personDetectionResult);
    }
    catch (const std::exception& e)
    {
        NX_OUTPUT << "Rendering error: " << e.what();
    }
    catch (...)
    {
        NX_OUTPUT << "Rendering error.";
    }
}

void App::renderImpl(
    cv::Mat frame,
    int64_t timestampUs,
    const ObjectDetectionProcessor::Result& personDetectionResult)
{
    using namespace std::chrono_literals;

    for (const std::shared_ptr<Detection>& detection: personDetectionResult.detections)
    {
        const auto boundingBox = convertBoostRectToCvRect(
            /*rect*/ detection->boundingBox,
            /*width*/ m_width,
            /*height*/ m_height);
        const cv::Scalar kRedColor = cv::Scalar(0, 0, 255);

        cv::rectangle(frame, boundingBox, kRedColor); //< Draw bounding box

        const nx::sdk::Uuid& trackId = detection->trackId;

        std::hash<nx::sdk::Uuid> idHashFunction;
        size_t idHash = idHashFunction(trackId) % 1000;

        std::stringstream ss;
        ss << std::fixed << std::setprecision(2) << detection->confidence;
        std::string confidence = ss.str();

        const RoiProcessor::Result& lineCrossingEvents = personDetectionResult.roiEvents;
        for (const auto& event: lineCrossingEvents)
        {
            const auto& lineCrossingEvent = std::dynamic_pointer_cast<LineCrossed>(event);
            if (lineCrossingEvent->trackId == trackId)
            {
                if (m_lineCrossingCount.find(trackId) == m_lineCrossingCount.end())
                    m_lineCrossingCount[trackId] = {
                        {Direction::absent,  0},
                        {Direction::left, 0},
                        {Direction::right, 0},
                    };
                ++m_lineCrossingCount[trackId][lineCrossingEvent->direction];
            }
        }
        int lineCrossingCountA = m_lineCrossingCount[trackId][Direction::left];
        int lineCrossingCountB = m_lineCrossingCount[trackId][Direction::right];

        cv::putText(
            frame,
            confidence + " " + std::to_string(idHash) + " " +
                std::to_string(lineCrossingCountA) + "," + std::to_string(lineCrossingCountB),
            cv::Point(boundingBox.x, boundingBox.y /*vertical text displacement*/ - 8),
            cv::FONT_HERSHEY_COMPLEX_SMALL,
            /*font scale*/ 1,
            kRedColor);

        cv::putText(
                frame,
                std::to_string(timestampUs),
                cv::Point(0, 16),
                cv::FONT_HERSHEY_COMPLEX_SMALL,
                /*font scale*/ 1,
                kRedColor);
    }
    drawLine(frame);
    cv::imshow(m_windowName, frame);
    constexpr std::chrono::milliseconds kDelay = 25ms;
    cv::waitKey(kDelay.count());
}

void App::updateConfig()
{
    m_drawingData->lineIsUpdated = false;
    m_config->lines.clear();
    const auto roiLine = std::make_shared<RoiLine>(RoiLine{
        {{{(float) m_drawingData->p0.x / m_width, (float) m_drawingData->p0.y / m_height},
        {(float) m_drawingData->p1.x / m_width, (float) m_drawingData->p1.y / m_height},}},
        Direction::absent,
    });
    m_config->lines.push_back(roiLine);
    m_personDetector->setConfig(m_config);
}

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
