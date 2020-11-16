// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#include "track.h"

#include "detection.h"

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

Track::Track(const nx::sdk::Uuid& id, int maxDetectionCount):
    m_id(id),
    m_maxDetectionCount(maxDetectionCount)
{
}

nx::sdk::Uuid Track::id() const
{
    return m_id;
}

std::shared_ptr<BestShot> Track::bestShot() const
{
    return m_bestShot;
}

Status Track::status() const
{
    return m_status;
}

void Track::addDetection(
    int64_t timestampUs,
    const DetectionPtr& detection,
    bool isTrackStarted)
{
    if (!detections.empty() && detections.size() == (size_t) m_maxDetectionCount)
        detections.erase(detections.begin());

    if (isTrackStarted)
    {
        if (m_status == Status::inactive)
            m_status = Status::started;
        else if (m_status == Status::started)
            m_status = Status::active;
    }

    detections.push_back(detection);
}

void Track::activate()
{
    m_status = Status::active;
}

void Track::finish()
{
    m_status = Status::finished;

    if (detections.empty())
        return;

    DetectionPtr& bestShotDetection = detections[0];
    for (DetectionPtr& detection: detections)
        if (detection->confidence > bestShotDetection->confidence)
            bestShotDetection = detection;
    m_bestShot = std::make_shared<BestShot>(BestShot({
        bestShotDetection->boundingBox,
        bestShotDetection->confidence,
        bestShotDetection->timestampUs,
        /*trackId*/ m_id,
    }));
}

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
