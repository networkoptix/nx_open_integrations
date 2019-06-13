// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

/**
 * Defines constants throughout the package.
 */
const config = {
    actionParams: {
        allUsers: false,
        durationMs: 5000,
        forced: true,
        fps: 10,
        needConfirmation: false,
        playToClient: true,
        recordAfter: 0,
        recordBeforeMs: 1000,
        requestType: 'R0VU',
        streamQuality: 'highest',
        useSource: false
    },
    actionParamsAdditionalResources: ['{00000000-0000-0000-0000-100000000000}',
                                      '{00000000-0000-0000-0000-100000000001}'],
    actionTypes: {
        execHttpRequestAction: 'execHttpRequestAction',
        showPopupAction: 'showPopupAction',
    },
    defaultExpressRoute: 'node',
    defaultSoftTriggerText: 'Soft Trigger made by node integration',
    eventCondition: {
        eventTimestampUsec: '0',
        eventType: 'undefinedEvent',
        metadata: {
            allUsers: false
        },
        reasonCode: 'none'
    },
    eventConditionMetaInstigators : ['{00000000-0000-0000-0000-100000000000}',
                                     '{00000000-0000-0000-0000-100000000001}'],
    eventTypes: {
        softwareTriggerEvent: 'softwareTriggerEvent',
        userDefinedEvent: 'userDefinedEvent'
    },
    softTriggerIcons: {
        bell: '_bell_on',
        cancel: 'ban',
        lightsOff: '_lights_off',
        lightsOn: '_lights_on',
        lock: '_lock_locked',
        unlocked: '_lock_unlocked'
    }
};

export default config;
