// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include <nx/sdk/uuid.h>

#include "geometry.h"

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

struct Event
{
    explicit Event(int64_t timestampUs, bool isActive = true):
        timestampUs(timestampUs), isActive(isActive) {}

    virtual std::string caption() const = 0;
    virtual std::string description() const { return ""; }
    virtual std::string type() const = 0;

    inline static const std::string kTypePrefix = "nx.openvino_object_detection.";

    int64_t timestampUs;
    bool isActive;
};

struct PeopleDetected: public Event
{
    explicit PeopleDetected(int64_t timestampUs, std::optional<int64_t> durationUs = std::nullopt):
        Event(timestampUs, !durationUs), durationUs(durationUs.value_or(0)) {}

    virtual std::string caption() const override
    {
        return kName + (isActive ? " (start)" : " (finish)");
    }

    virtual std::string description() const override
    {
        if (isActive)
            return "";

        std::stringstream ss;
        ss.setf(std::ios::fixed);
        ss.precision(1);
        ss << durationUs / 1e+6;

        return "Total time: " + ss.str() + " seconds";
    }

    virtual std::string type() const override { return kType; }

    inline static const std::string kName = "People Detected";
    inline static const std::string kType = kTypePrefix + "peopleDetected";

    int64_t durationUs;
};

struct PersonEvent: public Event
{
    nx::sdk::Uuid trackId;

    PersonEvent(int64_t timestampUs, nx::sdk::Uuid trackId, bool isActive = true):
        Event(timestampUs, isActive), trackId(trackId) {}
};

struct PersonDetected: public PersonEvent
{
    using PersonEvent::PersonEvent;

    virtual std::string caption() const override { return kName; }
    virtual std::string type() const override { return kType; }

    inline static const std::string kName = "Person Detected";
    inline static const std::string kType = kTypePrefix + "personDetected";
};

struct PersonLost: public PersonEvent
{
    using PersonEvent::PersonEvent;

    virtual std::string caption() const override { return kName; }
    virtual std::string type() const override { return kType; }

    inline static const std::string kName = "Person Lost";
    inline static const std::string kType = kTypePrefix + "personLost";
};

struct RoiEvent: public PersonEvent { using PersonEvent::PersonEvent; };

struct LineCrossed: public RoiEvent
{
    LineCrossed(
        int64_t timestampUs,
        nx::sdk::Uuid trackId,
        Direction direction,
        RoiLinePtr roiLine,
        bool isActive = true)
        :
        RoiEvent(timestampUs, trackId, true),
        direction(direction),
        roiLine(roiLine)
    {
    }

    virtual std::string description() const override
    {
        std::string result = "Detected on ";
        if (roiLine->name.empty())
            result += "line #" + std::to_string(roiLine->index);
        else
            result += roiLine->name;
        return result;
    }

    virtual std::string caption() const override { return kName; }
    virtual std::string type() const override { return kType; }

    inline static const std::string kName = "Line Crossed";
    inline static const std::string kType = kTypePrefix + "lineCrossed";

    Direction direction = Direction::none;
    RoiLinePtr roiLine;
};

struct AreaMonitoringEvent: public RoiEvent
{
    AreaMonitoringEvent(
        int64_t timestampUs,
        nx::sdk::Uuid trackId,
        RoiAreaPtr roiArea,
        bool isActive = true)
        :
        RoiEvent(timestampUs, trackId, true),
        roiArea(roiArea)
    {
    }

    virtual std::string description() const override
    {
        if (!roiArea)
            return "";

        std::string result = "Detected in ";
        if (roiArea->name.empty())
            result += "area #" + std::to_string(roiArea->index);
        else
            result += roiArea->name;
        return result;
    }

    RoiAreaPtr roiArea;
};

struct AreaEntranceDetected: public AreaMonitoringEvent
{
    using AreaMonitoringEvent::AreaMonitoringEvent;

    virtual std::string caption() const override { return kName; }
    virtual std::string type() const override { return kType; }

    inline static const std::string kName = "Area Entrance";
    inline static const std::string kType = kTypePrefix + "areaEntranceDetected";
};

struct AreaExitDetected: public AreaMonitoringEvent
{
    using AreaMonitoringEvent::AreaMonitoringEvent;

    virtual std::string caption() const override { return kName; }
    virtual std::string type() const override { return kType; }

    inline static const std::string kName = "Area Exit";
    inline static const std::string kType = kTypePrefix + "areaExitDetected";
};

struct AreaCrossed: public AreaMonitoringEvent
{
    using AreaMonitoringEvent::AreaMonitoringEvent;

    virtual std::string caption() const override { return kName; }
    virtual std::string type() const override { return kType; }

    inline static const std::string kName = "Area Crossed";
    inline static const std::string kType = kTypePrefix + "areaCrossed";
};

struct AppearanceInAreaDetected: public AreaMonitoringEvent
{
    using AreaMonitoringEvent::AreaMonitoringEvent;

    virtual std::string caption() const override { return kName; }
    virtual std::string type() const override { return kType; }

    inline static const std::string kName = "Appearance in Area";
    inline static const std::string kType = kTypePrefix + "appearanceInAreaDetected";
};

struct DisappearanceInAreaDetected: public AreaMonitoringEvent
{
    using AreaMonitoringEvent::AreaMonitoringEvent;

    virtual std::string caption() const override { return kName; }
    virtual std::string type() const override { return kType; }

    inline static const std::string kName = "Disappearance in Area";
    inline static const std::string kType = kTypePrefix + "disappearanceInAreaDetected";
};

struct Loitering: public Event
{
    explicit Loitering(int64_t timestampUs, std::optional<int64_t> durationUs = std::nullopt):
        Event(timestampUs, !durationUs), durationUs(durationUs.value_or(0)) {}

    virtual std::string caption() const override
    {
        return kName + (isActive ? " (start)" : " (finish)");
    }

    virtual std::string description() const override
    {
        if (isActive)
            return "";

        std::stringstream ss;
        ss.setf(std::ios::fixed);
        ss.precision(1);
        ss << durationUs / 1e+6;

        return "Total time: " + ss.str() + " seconds";
    }

    virtual std::string type() const override { return kType; }

    inline static const std::string kName = "Loitering";
    inline static const std::string kType = kTypePrefix + "loiteringDetected";

    int64_t durationUs;
};

using EventPtr = std::shared_ptr<Event>;
using PersonEventPtr = std::shared_ptr<PersonEvent>;
using EventList = std::vector<EventPtr>;
using PersonLostEventMap = std::map<nx::sdk::Uuid, PersonEventPtr>;

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
