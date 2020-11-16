// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#pragma once

#include <map>
#include <memory>
#include <vector>

#include <boost/optional.hpp>

#include <nx/sdk/analytics/rect.h>
#include <nx/sdk/uuid.h>

#include "best_shot.h"
#include "detection.h"
#include "geometry.h"
#include "status.h"

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

class Track
{
public:
    Track(const nx::sdk::Uuid& id, int maxDetectionCount);

    nx::sdk::Uuid id() const;
    BestShotPtr bestShot() const;
    Status status() const;
    void activate();
    void finish();

    void addDetection(
        int64_t timestampUs,
        const DetectionPtr& detection,
        bool isTrackStarted = true);

public:
    DetectionList detections;

private:
    const nx::sdk::Uuid m_id;
    Status m_status = Status::inactive;
    const int m_maxDetectionCount;
    BestShotPtr m_bestShot;
};

using TrackPtr = std::shared_ptr<Track>;
using TrackList = std::vector<TrackPtr>;
using TrackMap = std::map</*trackId*/ const nx::sdk::Uuid, /*track*/ TrackPtr>;

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
