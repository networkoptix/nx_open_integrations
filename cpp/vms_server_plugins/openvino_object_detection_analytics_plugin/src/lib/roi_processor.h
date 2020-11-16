// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#pragma once

#include <chrono>
#include <limits>
#include <map>
#include <set>
#include <utility>
#include <vector>
#include <optional>

#include <nx/sdk/analytics/helpers/object_metadata.h>
#include <nx/sdk/analytics/rect.h>
#include <nx/sdk/helpers/log_utils.h>
#include <nx/sdk/uuid.h>

#include "config.h"
#include "event.h"
#include "track.h"

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

class RoiProcessor
{
public:
    using Result = EventList;

public:
    RoiProcessor(nx::sdk::LogUtils logUtils, const std::shared_ptr<const Config> config);

    Result run(
        const TrackList& tracks,
        const EventList& events,
        bool analyzeOnlyForDisappearanceInAreaDetectedEvents);

    void setConfig(const std::shared_ptr<const Config> config);

private:
    enum class AreaState
    {
        none,
        outside,
        inside,
        entered,
        exited,
        appeared,
        disappeared,
    };

    class IntervalCalculator
    {
    public:
        void registerTimestamp(int64_t timestampUs);
        void pause();
        int64_t firstTimestamp() const;
        std::chrono::microseconds duration() const;

    private:
        std::chrono::microseconds m_durationWithoutLastInterval{0};
        int64_t m_firstTimestamp = 0;
        int64_t m_lastTimestamp = 0;
        int64_t m_lastIntervalStartTimestampUs = 0;
    };

    struct TrackContext
    {
        struct AreaContext
        {
            AreaState instantState = AreaState::none;
            AreaState filteredState = AreaState::none;
            AreaState newFilteredState = AreaState::none;
            int64_t newFilteredStateTimestampUs = std::numeric_limits<int64_t>::max();
            boost::optional<Point> detectionBoundingBoxCenterBeforeAreaEnter;
            IntervalCalculator intervalCalculator;
        };

        using AreaContextPtr = std::unique_ptr<AreaContext>;

        /**
         * ROI line is removed when bounding box of detection stops crossing the line.
         */
        std::set<RoiLinePtr> linesCrossed;

        std::map<RoiAreaPtr, AreaContextPtr> areasContexts;

        int detectionIndex = 0;
    };

    using TrackContextPtr = std::unique_ptr<TrackContext>;

private:
    static AreaState newInstantState(
        AreaState state,
        const Rect& boundingBox,
        const RoiAreaPtr& area);

    static EventList generateImpulseAreaEvents(
        TrackContext::AreaContext& areaContext,
        const RoiAreaPtr& area,
        const TrackPtr& track);

    static EventPtr generateAreaCrossedEvent(
        TrackContext::AreaContext& areaContext,
        const RoiAreaPtr& area,
        const TrackPtr& track,
        int detectionIndex);

    Result runImpl(
        const TrackList& tracks,
        const EventList& events,
        bool analyzeOnlyForDisappearanceInAreaDetectedEvents);

    static bool objectIntersectedArea(const Line& centerMovement, const RoiAreaPtr& area);
    void ensureTracksContexts(const TrackList &tracks);
    EventList lineCrossedDetection(const TrackList &tracks);
    EventList monitorArea(const TrackList &tracks);
    EventList generateDisappearanceInAreaAndLoiteringFinishEvents(const EventList& events);

private:
    std::shared_ptr<const Config> m_config;
    nx::sdk::LogUtils logUtils;
    std::map<const nx::sdk::Uuid, TrackContextPtr> m_tracksContexts;
    std::optional<int64_t> m_loiteringStartTimestampUs;
};

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
