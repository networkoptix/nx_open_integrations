// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
import * as uuid from 'uuid/v4';

import config from '../../../config';
import { BaseEvent } from './baseEvent';

/**
 * Represents a soft trigger from the Event Rules.
 * @class
 */
export class SoftTrigger extends BaseEvent {
    static readonly Icons:any = {
        "_alarm_off": "_alarm_off",
        "_alarm_on": "_alarm_on",
        "_bell_off": "_bell_off",
        "_bell_on": "_bell_on",
        "_door_closed": "_door_closed",
        "_door_opened": "_door_opened",
        "_elevator_doors_close": "_elevator_doors_close",
        "_elevator_doors_open": "_elevator_doors_open",
        "_elevator_down": "_elevator_down",
        "_elevator_up": "_elevator_up",
        "_escalator__start": "_escalator__start",
        "_escalator__stop": "_escalator__stop",
        "_escalator_down": "_escalator_down",
        "_escalator_up": "_escalator_up",
        "_hvac_fan_start": "_hvac_fan_start",
        "_hvac_fan_stop": "_hvac_fan_stop",
        "_hvac_temp_down": "_hvac_temp_down",
        "_hvac_temp_up": "_hvac_temp_up",
        "_lights2_off": "_lights2_off",
        "_lights2_on": "_lights2_on",
        "_lights_off": "_lights_off",
        "_lights_on": "_lights_on",
        "_lock_locked": "_lock_locked",
        "_lock_unlocked": "_lock_unlocked",
        "_parking_gates_closed": "_parking_gates_closed",
        "_parking_gates_open": "_parking_gates_open",
        "_power_off": "_power_off",
        "_power_on": "_power_on",
        "_simple_arrow_h_left": "_simple_arrow_h_left",
        "_simple_arrow_h_right": "_simple_arrow_h_right",
        "_simple_arrow_v_down": "_simple_arrow_v_down",
        "_simple_arrow_v_up": "_simple_arrow_v_up",
        "_simple_minus": "_simple_minus",
        "_simple_plus": "_simple_plus",
        "_thumb_down": "_thumb_down",
        "_thumb_up": "_thumb_up",
        "_wipers_on": "_wipers_on",
        "_wipers_wash": "_wipers_wash",
        "ban": "ban",
        "bookmark": "bookmark",
        "bubble": "bubble",
        "circle": "circle",
        "fire": "fire",
        "list.txt": "list.txt",
        "message": "message",
        "mic": "mic",
        "puzzle": "puzzle",
        "siren": "siren",
        "speaker": "speaker"
    };

    /**
     * @param {string} buttonText The text that shows up on the soft trigger.
     * @param {string} icon The string value of the icon you want the soft trigger to show.
     * @constructor
     */
    constructor(buttonText?: string, icon?: string) {
        super(config.eventTypes.softwareTriggerEvent);
        this.config({buttonText, icon});
    }

    /**
     * Configures the soft trigger.
     * @param {string} buttonText The text that shows up on the soft trigger.
     * @param {string} icon The string value of the icon you want the soft trigger to show.
     */
    public config({buttonText= config.defaultSoftTriggerText, icon= config.softTriggerIcons.bell }: {
        buttonText?: string, icon?: string
    }) {
        this.eventCondition.caption = buttonText;
        this.eventCondition.description = icon;
        this.eventCondition.inputPortId = `{${uuid()}}`;
        this.eventCondition.metadata.instigators = [... config.eventConditionMetaInstigators];
    }
}
