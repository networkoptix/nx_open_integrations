// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
import config from '../../../config';
import { factory } from '../../../logConfig';
import { BaseEvent } from './baseEvent';

const logging = factory.getLogger('Generic Event');

/**
 * Represents a generic event from the Event Rules.
 */
export class GenericEvent extends BaseEvent {
    /**
     * @param {string} source The source of the event.
     * @param {string} caption The caption you want to show.
     * @param {string} description A more detailed description of the event.
     * @constructor
     */
    constructor(source?: string, caption?: string, description?: string) {
        super(config.eventTypes.userDefinedEvent);
        this.eventCondition.metadata.instigators = [...config.eventConditionMetaInstigators];
        this.eventCondition.metadata.cameraRefs = [];
        this.config({ source, caption, description });
    }

    /**
     * Configures the generic event.
     * @param {string} source The source of the event.
     * @param {string} caption The caption you want to show.
     * @param {string} description A more detailed description of the event.
     */
    public config({ source, caption, description }: {
        source?: string, caption?: string, description?: string
    }) {
        if (caption !== undefined) {
            this.eventCondition.caption = caption;
        }
        if (description !== undefined) {
            this.eventCondition.description = description;
        }
        if (source !== undefined) {
            this.eventCondition.resourceName = source;
        }
    }

    /**
     * Sets the cameraRefs for when the event is sent to the system.
     * @param {string[]} cameraRefs
     */
    public setCameraIds(cameraRefs: string[]) {
        this.eventCondition.metadata.cameraRefs = [cameraRefs];
    }

    /**
     * Turns the class object into a querystring.
     * @return {{[p: string]: any}}
     */
    public formatQueryString() {
        const queryString: { [key: string]: any } = {};
        if (this.eventCondition.resourceName) {
            queryString.source = this.eventCondition.resourceName;
        }
        if (this.eventCondition.caption) {
            queryString.caption = this.eventCondition.caption;
        }
        if (this.eventCondition.description) {
            queryString.description = this.eventCondition.description;
        }

        if (this.eventCondition.metadata.cameraRefs.length > 0) {
            queryString.metadata = {};
            queryString.metadata.cameraRefs = this.eventCondition.metadata.cameraRefs;
            queryString.metadata = JSON.stringify(queryString.metadata);
        }
        queryString.event_type = config.eventTypes.userDefinedEvent;
        return queryString;
    }
}
