// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

import config from '../../../config';
import { BaseAction } from './baseAction';

/**
 * HttpAction represents the HttpAction from the Event Rules.
 * @class
 */
export class HttpAction extends BaseAction {
    /**
     * @param {string} targetUrl Where the http action makes the GET/POST request to.
     * @constructor
     */
    constructor(targetUrl?: string) {
        super(config.actionTypes.execHttpRequestAction);
        if (targetUrl !== undefined) {
            this.config(targetUrl);
        }
    }

    /**
     * Adds the url target for the httpAction.
     * @param {string} targetUrl Where to send the GET/POST request.
     */
    public config(targetUrl: string) {
        this.actionParams.url = targetUrl;
    }
}
