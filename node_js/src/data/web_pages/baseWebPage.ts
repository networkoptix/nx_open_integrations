// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
import { factory } from '../../logConfig';

const logging = factory.getLogger('Base Web Page');

/**
 * A web page in the Server resource tree.
 * @class
 */
export class BaseWebPage {
    public id: string;
    public url: string;
    public pageName: string;

    /**
     * @param {string} id The id of the web page that is a unique identifier.
     * @param {string} pageName The name of the web page.
     * @param {string} url The url of the web page.
     * @constructor
     */
    public constructor(id: string, pageName: string, url: string) {
        logging.info(`Web Page called ${pageName} was created. Url is ${url}`);
        this.id = id;
        this.url = url;
        this.pageName = pageName;
    }
}