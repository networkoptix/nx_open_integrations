// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
import { factory } from '../logConfig';
import {BaseWebPage} from "../data/web_pages";

const logging = factory.getLogger('Web Page Manager');

/**
 * The WebPageManager helps check if a web page exists on the system.
 * @class
 */
export class WebPageManager {
    /**
     * A list of web page from the config file and system.
     * @type {{}}
     */
    protected webPages: { [key: string]: {} } = {};

    /**
     * Sets the web page ids from the config file.
     * @param {{[p: string]: string}} configPages
     * @constructor
     */
    constructor({ configPages = {} }: { configPages?: { [key: string]: {} } }) {
        logging.info(JSON.stringify(configPages));
        this.webPages = configPages;
    }

    /**
     * Checks if the web page is in the config.
     * @param {BaseWebPage} webPage
     * @return {string}
     */
    public pageExists(webPage: BaseWebPage) {
        const pages = Object.keys(this.webPages).filter((id) => {
            return this.webPages[id] === webPage.id;
        });

        return pages.length > 0 ? pages[0] : '';
    }

    /**
     * Sets the web pages from the system.
     * @param {any} pages
     * @return {this}
     */
    public setPageIds(pages: any) {
        pages.forEach((page: any) => {
            if (!(page.id in this.webPages)) {
                this.webPages[page.id] = '';
            }
        });
        return this;
    }
}
