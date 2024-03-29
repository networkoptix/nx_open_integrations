// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
import config from '../../../config';
import { factory } from '../../../logConfig';

const logging = factory.getLogger('Base Event');

/**
 * Base event class for all other event classes.
 * @class
 */
export class BaseEvent {
    /**
     * The type of event. See [[config.eventTypes]] for a list of supported events.
     */
    public eventType: string;
    /**
     * Parameters related to the event part of a rule.
     */
    public eventCondition: { [key: string]: any };

    /**
     * @param {string} eventType
     * @constructor
     */
    public constructor(eventType: string) {
        logging.info(`Event of type ${eventType} was created.`);
        this.eventType = eventType;
        this.eventCondition = { ...config.eventCondition };
    }

    /**
     * Turns the class object into a querystring.
     * @return {{}}
     * @ignore
     */
    public formatQueryString() {
        return {};
    }
}
