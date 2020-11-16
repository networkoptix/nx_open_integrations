// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#include "roi_processor.h"

#include <memory>
#include <vector>
#include <unordered_set>

#include <boost/geometry/strategies/strategies.hpp>

#define NX_PRINT_PREFIX (this->logUtils.printPrefix)
#include <nx/kit/debug.h>
#include <nx/kit/utils.h>
#include <nx/sdk/uuid.h>
#include <nx/sdk/helpers/log_utils.h>
#include <nx/sdk/helpers/uuid_helper.h>

#include "config.h"
#include "exceptions.h"
#include "openvino_object_detection_analytics_plugin_ini.h"

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

using namespace std::chrono;

using namespace nx::sdk;
using namespace nx::sdk::analytics;

RoiProcessor::RoiProcessor(
    LogUtils logUtils,
    const std::shared_ptr<const Config> config):
    m_config(config),
    logUtils(logUtils)
{
}

void RoiProcessor::setConfig(const std::shared_ptr<const Config> config)
{
    m_config = config;
    m_tracksContexts.clear();
}

RoiProcessor::Result RoiProcessor::run(
    const TrackList& tracks,
    const EventList& events,
    bool analyzeOnlyForDisappearanceInAreaDetectedEvents)
{
    try
    {
        using namespace std::chrono;
        const auto startTime = high_resolution_clock::now();

        const Result result = runImpl(
            tracks,
            events,
            analyzeOnlyForDisappearanceInAreaDetectedEvents);

        const auto finishTime = high_resolution_clock::now();
        const auto duration = duration_cast<milliseconds>(finishTime - startTime);
        NX_OUTPUT << "ROI processing duration: " << duration.count() << " ms.";

        return result;
    }
    catch (const std::exception& e)
    {
        throw RoiError("ROI processing error: "s + e.what());
    }
}

//-------------------------------------------------------------------------------------------------
// private

void RoiProcessor::ensureTracksContexts(const TrackList& tracks)
{
    std::unordered_set<nx::sdk::Uuid> currentTracksIds;
    for (const auto& track: tracks)
        currentTracksIds.insert(track->id());

    for (auto it = m_tracksContexts.begin(); it != m_tracksContexts.end();)
    {
        if (currentTracksIds.find(it->first) == currentTracksIds.end())
            it = m_tracksContexts.erase(it);
        else
            ++it;
    }

    for (auto& trackId: currentTracksIds)
    {
        if (m_tracksContexts.find(trackId) == m_tracksContexts.end())
        {
            m_tracksContexts.insert(std::make_pair(trackId, std::make_unique<TrackContext>()));
            for (auto& roiArea: m_config->areas)
            {
                m_tracksContexts[trackId]->areasContexts.insert(
                    std::make_pair(roiArea, std::make_unique<TrackContext::AreaContext>()));
            }
        }
    }
}

EventList RoiProcessor::lineCrossedDetection(const TrackList& tracks)
{
    EventList result;

    for (const auto& track: tracks)
    {
        auto& trackContext = *m_tracksContexts.at(track->id());
        auto& linesCrossed = trackContext.linesCrossed;

        for (int detectionIndex = trackContext.detectionIndex;
            detectionIndex < track->detections.size();
            ++detectionIndex)
        {
            if (detectionIndex == 0)
                continue;

            const Line trackLine = Line{
                bg::return_centroid<Point>(
                track->detections[detectionIndex - 1]->boundingBox),
                bg::return_centroid<Point>(
                track->detections[detectionIndex]->boundingBox),
            };

            for (const auto& roiLine: m_config->lines)
            {
                const bool trackDidNotCrossLine = linesCrossed.find(roiLine) == linesCrossed.end();
                if (trackDidNotCrossLine)
                {
                    const auto direction = intersectionDirection(roiLine->value, trackLine);
                    if (direction != Direction::none &&
                        (direction == roiLine->direction ||
                        roiLine->direction == Direction::absent))
                    {
                        linesCrossed.insert(roiLine);
                        result.push_back(std::make_shared<LineCrossed>(LineCrossed(
                            track->detections[detectionIndex]->timestampUs,
                            track->id(),
                            direction,
                            roiLine
                        )));
                    }
                }
                else
                {
                    const Rect lastDetectionBoundingBox =
                        track->detections[detectionIndex]->boundingBox;
                    if (!bg::intersects(lastDetectionBoundingBox, roiLine->value))
                        linesCrossed.erase(roiLine);
                }
            }

        }

    }

    return result;
}

bool RoiProcessor::objectIntersectedArea(const Line& centerMovement, const RoiAreaPtr& area)
{
    const Line areaCenterLine = linePerpendicular(centerMovement, area->getCentroid());
    const boost::optional<Point> intersection =
        lineSegmentIntersectionPoint(areaCenterLine, centerMovement);
    return intersection && bg::within(intersection.value(), area->value);
}

RoiProcessor::AreaState RoiProcessor::newInstantState(
    RoiProcessor::AreaState state,
    const Rect& boundingBox,
    const RoiAreaPtr& area)
{
    const float objectPartInsideArea = rectFractionInsidePolygon(boundingBox, area->value);
    const bool insideArea = objectPartInsideArea >= (1 - area->detectionSensitivity);
    if (state == AreaState::none)
    {
        if (insideArea)
            return AreaState::appeared;
        else
            return AreaState::outside;
    }
    else if (state == AreaState::outside ||
        state == AreaState::exited ||
        state == AreaState::disappeared)
    {
        if (insideArea)
            return AreaState::entered;
        else
            return AreaState::outside;
    }
    else if (state == AreaState::inside ||
        state == AreaState::entered ||
        state == AreaState::appeared)
    {
        if (insideArea)
            return AreaState::inside;
        else
            return AreaState::exited;
    }
    return AreaState::none;
}

EventPtr RoiProcessor::generateAreaCrossedEvent(
    TrackContext::AreaContext& areaContext,
    const RoiAreaPtr& area,
    const TrackPtr& track,
    const int detectionIndex)
{
    if (track->detections.empty())
        return {};

    auto lastDetectionCenter = bg::return_centroid<Point>(
       track->detections[detectionIndex]->boundingBox);

    if (!areaContext.detectionBoundingBoxCenterBeforeAreaEnter)
    {
        areaContext.detectionBoundingBoxCenterBeforeAreaEnter = lastDetectionCenter;
        return {};
    }

    const Line centerMovement{
        areaContext.detectionBoundingBoxCenterBeforeAreaEnter.value(),
        lastDetectionCenter,
    };
    if (objectIntersectedArea(centerMovement, area) && area->crossingEnabled)
        return std::make_shared<AreaCrossed>(AreaCrossed(
            areaContext.newFilteredStateTimestampUs, track->id(), area));

    return {};
}

EventList RoiProcessor::generateImpulseAreaEvents(
    RoiProcessor::TrackContext::AreaContext& areaContext,
    const RoiAreaPtr& area,
    const TrackPtr& track)
{
    EventList result;
    if (areaContext.filteredState == AreaState::entered && area->entranceDetectionEnabled)
    {
        result.push_back(std::make_shared<AreaEntranceDetected>(AreaEntranceDetected(
            areaContext.newFilteredStateTimestampUs,
            track->id(),
            area)));
    }
    else if (areaContext.filteredState == AreaState::exited && area->exitDetectionEnabled)
    {
        result.push_back(std::make_shared<AreaExitDetected>(AreaExitDetected(
            areaContext.newFilteredStateTimestampUs,
            track->id(),
            area)));
    }
    else if (areaContext.filteredState == AreaState::appeared && area->appearanceDetectionEnabled)
    {
        result.push_back(std::make_shared<AppearanceInAreaDetected>(AppearanceInAreaDetected(
            areaContext.newFilteredStateTimestampUs,
            track->id(),
            area)));
    }
    return result;
}

PersonLostEventMap convertEventListToPersonLostEventMap(const EventList& events)
{
    PersonLostEventMap result;

    for (const auto& event: events)
    {
        auto objectEvent = std::dynamic_pointer_cast<PersonLost>(event);
        if (objectEvent)
            result.insert(std::make_pair(objectEvent->trackId, objectEvent));
    }

    return result;
}

EventList RoiProcessor::monitorArea(const TrackList& tracks)
{
    if (tracks.empty())
        return {};

    EventList result;
    for (const auto& track: tracks)
    {
        if (track->status() == Status::inactive)
            continue;

        auto& trackContext = *m_tracksContexts.at(track->id());
        auto& areasContexts = trackContext.areasContexts;

        for (auto& pair: areasContexts)
        {
            const auto& area = pair.first;
            auto& areaContext = *pair.second;

            for (int detectionIndex = trackContext.detectionIndex;
                 detectionIndex < track->detections.size();
                 ++detectionIndex)
            {
                areaContext.instantState = newInstantState(
                    areaContext.instantState,
                    track->detections[detectionIndex]->boundingBox,
                    area);

                static const int64_t kFilteredStateDelayUs = 1000000;
                const int64_t timestampUs = track->detections[detectionIndex]->timestampUs;
                if (areaContext.filteredState == AreaState::entered ||
                    areaContext.filteredState == AreaState::appeared)
                {
                    areaContext.filteredState = AreaState::inside;
                }
                else if (areaContext.filteredState == AreaState::exited)
                {
                    areaContext.filteredState = AreaState::outside;
                }
                else if (areaContext.filteredState == AreaState::disappeared)
                {
                    areaContext.filteredState = AreaState::none;
                }

                if (area->loiteringDetectionEnabled)
                {
                    if (areaContext.filteredState == AreaState::appeared ||
                        areaContext.filteredState == AreaState::entered ||
                        areaContext.filteredState == AreaState::inside)
                    {
                        areaContext.intervalCalculator.registerTimestamp(
                            track->detections[detectionIndex]->timestampUs);
                    }
                    else if (areaContext.filteredState == AreaState::exited)
                    {
                        areaContext.intervalCalculator.pause();
                    }

                    microseconds timeIntervalInsideArea =
                        areaContext.intervalCalculator.duration();

                    NX_OUTPUT << "Track: " << nx::sdk::UuidHelper::toStdString(track->id()) <<
                        ", " << "inside: " <<
                        duration_cast<milliseconds>(timeIntervalInsideArea).count() << " ms.";

                    if (timeIntervalInsideArea >= area->loiteringDetectionDuration
                        && !m_loiteringStartTimestampUs)
                    {
                        m_loiteringStartTimestampUs =
                            areaContext.intervalCalculator.firstTimestamp();

                        result.push_back(std::make_shared<Loitering>(*m_loiteringStartTimestampUs));
                    }

                }

                if (areaContext.instantState == AreaState::entered ||
                    areaContext.instantState == AreaState::appeared ||
                    areaContext.instantState == AreaState::exited ||
                    areaContext.instantState == AreaState::disappeared)
                {
                    areaContext.newFilteredStateTimestampUs = timestampUs;
                    areaContext.newFilteredState = areaContext.instantState;
                }
                else
                {
                    if (areaContext.newFilteredStateTimestampUs !=
                        std::numeric_limits<int64_t>::max() &&
                        timestampUs >=
                        areaContext.newFilteredStateTimestampUs + kFilteredStateDelayUs)
                    {
                        if (((areaContext.newFilteredState == AreaState::appeared ||
                            areaContext.newFilteredState == AreaState::entered) &&
                            (areaContext.filteredState == AreaState::outside ||
                            areaContext.filteredState == AreaState::none)) ||
                            ((areaContext.newFilteredState == AreaState::disappeared ||
                            areaContext.newFilteredState == AreaState::exited) &&
                            areaContext.filteredState == AreaState::inside))
                        {
                            areaContext.filteredState = areaContext.newFilteredState;

                            EventList areaImpulseEvents = generateImpulseAreaEvents(
                                areaContext,
                                area,
                                track);

                            result.insert(
                                result.end(),
                                areaImpulseEvents.begin(),
                                areaImpulseEvents.end());

                            if (detectionIndex > 0 &&
                                areaContext.filteredState == AreaState::entered)
                            {
                                areaContext.detectionBoundingBoxCenterBeforeAreaEnter =
                                    bg::return_centroid<Point>(
                                    track->detections[detectionIndex - 1]->boundingBox);
                            }
                            else if (areaContext.filteredState == AreaState::exited ||
                                areaContext.filteredState == AreaState::disappeared ||
                                areaContext.filteredState == AreaState::outside)
                            {
                                EventPtr areaCrossedEvent = generateAreaCrossedEvent(
                                    areaContext,
                                    area,
                                    track,
                                    detectionIndex);

                                if (areaCrossedEvent)
                                    result.push_back(areaCrossedEvent);
                            }
                        }
                        areaContext.newFilteredStateTimestampUs =
                            std::numeric_limits<int64_t>::max();
                    }
                }
            }
        }
    }

    return result;
}

EventList RoiProcessor::generateDisappearanceInAreaAndLoiteringFinishEvents(
    const EventList& events)
{
    if (events.empty())
        return {};

    EventList result;
    PersonLostEventMap trackIdToPersonLostEventMap = convertEventListToPersonLostEventMap(events);
    int64_t timestampUs = events[0]->timestampUs;
    bool loiteringActive = false;

    for (const auto& trackIdAndTrackContext: m_tracksContexts)
    {
        const auto& trackId = trackIdAndTrackContext.first;
        auto& trackContext = trackIdAndTrackContext.second;
        auto& areasContexts = trackContext->areasContexts;

        for (auto& areaAndAreaContext: areasContexts)
        {
            const auto& area = areaAndAreaContext.first;
            auto& areaContext = *areaAndAreaContext.second;
            const microseconds timeIntervalInsideAreaUs =
                areaContext.intervalCalculator.duration();

            if (trackIdToPersonLostEventMap.find(trackId) != trackIdToPersonLostEventMap.end())
            {
                if (areaContext.filteredState == AreaState::entered ||
                    areaContext.filteredState == AreaState::appeared ||
                    areaContext.filteredState == AreaState::inside)
                {
                    if (area->disappearanceDetectionEnabled)
                    {
                        const auto& personLostEvent = trackIdToPersonLostEventMap[trackId];

                        result.push_back(std::make_shared<DisappearanceInAreaDetected>(
                            DisappearanceInAreaDetected(
                                personLostEvent->timestampUs,
                                trackId,
                                area)));
                    }
                    areaContext.instantState = AreaState::disappeared;
                    areaContext.filteredState = AreaState::disappeared;
                }
            }
            else if (timeIntervalInsideAreaUs >= area->loiteringDetectionDuration)
            {
                loiteringActive = true;
            }
        }
    }

    if (m_loiteringStartTimestampUs && !loiteringActive)
    {
        result.push_back(std::make_shared<Loitering>(
            timestampUs, timestampUs - *m_loiteringStartTimestampUs));

        m_loiteringStartTimestampUs = std::nullopt;
    }

    return result;
}

RoiProcessor::Result RoiProcessor::runImpl(
    const TrackList& tracks,
    const EventList& events,
    bool analyzeOnlyForDisappearanceInAreaDetectedEvents)
{
    EventList result = generateDisappearanceInAreaAndLoiteringFinishEvents(events);

    if (analyzeOnlyForDisappearanceInAreaDetectedEvents)
        return result;

    ensureTracksContexts(tracks);
    EventList lineEvents = lineCrossedDetection(tracks);
    EventList areaEvents = monitorArea(tracks);

    for (const auto& track: tracks)
    {
        auto &trackContext = *m_tracksContexts.at(track->id());
        trackContext.detectionIndex = (int) track->detections.size() - 1;
    }

    result.reserve(lineEvents.size() + areaEvents.size());
    result.insert(result.end(), lineEvents.begin(), lineEvents.end());
    result.insert(result.end(), areaEvents.begin(), areaEvents.end());
    return result;
}

void RoiProcessor::IntervalCalculator::registerTimestamp(int64_t timestampUs)
{
    if (m_firstTimestamp == 0)
        m_firstTimestamp = timestampUs;
    if (m_lastIntervalStartTimestampUs == 0)
        m_lastIntervalStartTimestampUs = timestampUs;

    m_lastTimestamp = timestampUs;
}

void RoiProcessor::IntervalCalculator::pause()
{
    m_durationWithoutLastInterval +=
        microseconds(m_lastTimestamp - m_lastIntervalStartTimestampUs);
    m_lastIntervalStartTimestampUs = 0;
}

int64_t RoiProcessor::IntervalCalculator::firstTimestamp() const
{
    return m_firstTimestamp;
}

std::chrono::microseconds RoiProcessor::IntervalCalculator::duration() const
{
    return m_durationWithoutLastInterval +
        microseconds(m_lastTimestamp - m_lastIntervalStartTimestampUs);
}

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
