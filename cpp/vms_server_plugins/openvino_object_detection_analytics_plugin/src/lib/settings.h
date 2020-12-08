// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#pragma once

#define OPENVINO_OBJECT_DETECTION_SETTING_NAME_FUNCTION(namePostfix) \
    static auto name = [](int index) { return settingName(index, namePostfix); };
#define OPENVINO_OBJECT_DETECTION_SETTING_DEFAULT(value) \
    static constexpr auto kDefault = value;
#define OPENVINO_OBJECT_DETECTION_SETTING(namePostfix, defaultValue) \
    OPENVINO_OBJECT_DETECTION_SETTING_NAME_FUNCTION(namePostfix) \
    OPENVINO_OBJECT_DETECTION_SETTING_DEFAULT(defaultValue)

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

namespace settings {

namespace roi_line {

static std::string settingPrefix(int index)
{
    return "line" + std::to_string(index);
}

static std::string settingName(int index, const std::string& name)
{
    return settingPrefix(index) + name;
}

namespace polyline {

OPENVINO_OBJECT_DETECTION_SETTING_NAME_FUNCTION("Polyline")

} // namespace polyline

} // namespace roi_line

namespace roi_area {

static std::string settingPrefix(int index)
{
    return "area" + std::to_string(index);
}

static std::string settingName(int index, const std::string& name)
{
    return settingPrefix(index) + name;
}

namespace polygon {

OPENVINO_OBJECT_DETECTION_SETTING_NAME_FUNCTION("Polygon")

} // namespace polygon

namespace entrance_detection_enabled {

OPENVINO_OBJECT_DETECTION_SETTING("EntranceDetectionEnabled", true)

} // namespace entrance_detection_enabled

namespace exit_detection_enabled {

OPENVINO_OBJECT_DETECTION_SETTING("ExitDetectionEnabled", true)

} // namespace exit_detection_enabled

namespace appearance_detection_enabled {

OPENVINO_OBJECT_DETECTION_SETTING("AppearanceDetectionEnabled", true)

} // namespace appearance_detection_enabled

namespace disappearance_detection_enabled {

OPENVINO_OBJECT_DETECTION_SETTING("DisappearanceDetectionEnabled", true)

} // namespace disappearance_detection_enabled

namespace loitering_detection_enabled {

OPENVINO_OBJECT_DETECTION_SETTING("LoiteringDetectionEnabled", true)

} // namespace loitering_detection_enabled

namespace crossing_enabled {

OPENVINO_OBJECT_DETECTION_SETTING("CrossingEnabled", true)

} // namespace crossing_enabled

namespace detection_sensitivity {

OPENVINO_OBJECT_DETECTION_SETTING("DetectionSensitivity", 0.5F)

} // namespace detection_sensitivity

namespace loitering_detection_duration {

using namespace std::literals::chrono_literals;

OPENVINO_OBJECT_DETECTION_SETTING("LoiteringDetectionDuration", 10s)

} // namespace loitering_detection::duration

} // namespace roi_area

} // namespace settings

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
