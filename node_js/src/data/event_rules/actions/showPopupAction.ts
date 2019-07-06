// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
import config from '../../../config';
import { BaseAction } from './baseAction';

/**
 * ShowPopup represents the show notification action in the Event Rules.
 * @class
 */
export class ShowPopup extends BaseAction {
    /**
     * @constructor
     */
    constructor() {
        super(config.actionTypes.showPopupAction);
        this.actionParams.additionalResources = [...config.actionParamsAdditionalResources];
    }

    /**
     * This function is not currently used.
     * @ignore
     */
    public config() {
        return;
    }
}
