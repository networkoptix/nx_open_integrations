// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#pragma once

#include <memory>
#include <utility>

#include <filesystem>

#include <opencv2/videoio.hpp>

#include <nx/sdk/helpers/log_utils.h>

#include "lib/object_detection_processor.h"

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

class App
{
public:
    struct DrawingData
    {
        bool clicked = false;
        bool lineIsDrawn = false;
        bool lineIsUpdated = false;
        cv::Point p0;
        cv::Point p1;
    };

public:
    App(std::filesystem::path inputFile, std::filesystem::path modelDir);
    void run();

protected:
    nx::sdk::LogUtils logUtils;

private:
    static void onMouse(int event, int x, int y, int, void* userData) noexcept;

    cv::Mat readFrame() noexcept;
    cv::Mat readFrameImpl();
    void render(
        cv::Mat frame,
        int64_t timestampUs,
        const ObjectDetectionProcessor::Result& personDetectionResult) noexcept;
    void renderImpl(
        cv::Mat frame,
        int64_t timestampUs,
        const ObjectDetectionProcessor::Result& personDetectionResult);
    void drawLine(cv::Mat frame) noexcept;
    void updateConfig();

private:
    const std::filesystem::path m_inputFile;
    const std::filesystem::path m_modelDir;
    cv::VideoCapture m_videoInput;
    std::unique_ptr<ObjectDetectionProcessor> m_personDetector;
    int m_width = 0;
    int m_height = 0;
    std::string m_windowName = "OpenVINO object detection test app";
    std::shared_ptr<DrawingData> m_drawingData = std::make_shared<DrawingData>();
    std::shared_ptr<Config> m_config = std::make_shared<Config>();
    std::map<const nx::sdk::Uuid, std::map<Direction, int>> m_lineCrossingCount;
};

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
