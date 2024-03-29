// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

import * as mustache from 'mustache';
import config from '../config';
import { BaseWebPage, Logger } from 'nx-node-integration';

const logging = Logger.getLogger('Button Web Page');

/** Default css classes used for text colors of the webpage button. */
export enum ButtonColors  {
    brand = 'brand',
    dark = 'dark',
    green = 'green',
    light = 'light',
    red = 'red',
    yellow = 'yellow'
}

/** Default css classes used for the background of the webpage button. */
export enum BackgroundColors {
    light1 = 'light1',
    light10 = 'light10',
    light17 = 'light17',
    dark14 = 'dark14',
    dark9 = 'dark9',
    dark5 = 'dark5',
    dark3 = 'dark3',
    dark1 = 'dark1'
}

/**
 * Represents an interactive web page on the Server.
 * @class
 */
export class ButtonWebPage extends BaseWebPage {
    public backgroundColor: string;
    public buttonColor: string;
    public buttonIcon: string;
    public buttonText: string;
    public callback: any;
    public mustacheTemplate: string;
    public pageId: string;
    public route: string;
    public showIcon: boolean;
    public showText: boolean;
    public state: any;

    /**
     * @param id The id of the web page that is a unique identifier.
     * @param pageName The name of the web page.
     * @param url The url of the web page.
     * @param buttonText The text for the button.
     * @param buttonColor The color of the button's text and icon.
     * @param buttonIcon The icon for the button.
     * @param backgroundColor The background color for the button.
     * @constructor
     */
    constructor(id: string, pageName: string, url: string, buttonText?: string, buttonColor?: string,
                buttonIcon?: string, backgroundColor?: string) {
        super(id, pageName, url);
        this.backgroundColor = backgroundColor || config.defaultBackgroundColor;
        this.buttonColor = buttonColor || config.defaultButtonColor;
        this.buttonIcon = buttonIcon || '';
        this.buttonText = buttonText || '';
        this.callback = () => {};
        this.id = id;
        this.mustacheTemplate = '';
        this.pageId = '';
        this.route = '';
        this.showIcon = buttonIcon !== undefined && buttonIcon !== '';
        this.showText = buttonText !== undefined && buttonText !== '';
        this.state = undefined;
    }

    /**
     * Helps configure the button. This function can be used to make buttons appearance change dynamically.
     * @param backgroundColor The background color for the button.
     * @param color The text/icon color for the button.
     * @param icon The icon for the button.
     * @param state The current state for the button.
     * @param showIcon Determines if the icon should be shown.
     * @param showText Determines if the text should be shown.
     * @param text The text for the button.
     */
    public configButton({ backgroundColor, color, icon, state, showIcon, showText, text}: {
        backgroundColor?: string, color?: string, icon?: string,
        showIcon?: boolean, showText?: boolean, state?: string, text?: string
    }) {
        if (backgroundColor !== undefined) {
            this.backgroundColor = backgroundColor;
        }
        if (color !== undefined) {
            this.buttonColor = color;
        }
        if (icon !== undefined) {
            this.buttonIcon = icon;
            if (icon) {
                this.showIcon = true;
            }
        }
        if (state !== undefined) {
            this.state = state;
        }
        if (text !== undefined) {
            this.buttonText = text;
            if (text) {
                this.showText = true;
            }
        }
        if (showIcon !== undefined) {
            this.showIcon = showIcon;
        }
        if (showText !== undefined) {
            this.showText = showText;
        }
        this.setUrl();
    }

    /**
     * Sets the base route for the button web page url.
     * @param address The ip address and port of the system serving the web page button.
     * @param route The route on the express server that returns the button.
     */
    public setRoute(address: string, route: string) {
        this.route = `${address}/${route}`;
        this.setUrl();
    }

    /**
     * Sets the url for the web page button. Pass in the address and route to overwrite the default
     * address and route.
     * @param address Sets the address for the web page button.
     * @param route Sets the route for the web page button.
     */
    public setUrl(address?: string, route?: string) {
        if (address !== undefined) {
            this.url = `${address}/${route}/${this.id}?state=${this.state}`;
        } else {
            this.url = `${this.route}/${this.id}?state=${this.state}`;
        }
    }

    /**
     * Renders the web page button from the mustache template.
     */
    public renderButton() {
        const data = {
            background: this.backgroundColor,
            color: this.buttonColor,
            icon: this.buttonIcon,
            name: this.buttonText,
            showIcon: this.showIcon,
            showText: this.showText,
            url: `${this.url}&next=1`,
            isChar: this.buttonText.length === 1
        };
        return mustache.render(this.mustacheTemplate, data);
    }

    /**
     * Sets the mustache template.
     * @param template A string that is a mustache html template.
     */
    public setMustacheTemplate(template: string) {
        this.mustacheTemplate = template;
    }

    /**
     * Sets the page id that is returned by the Server.
     * @param pageId
     */
    public setPageId(pageId: string) {
        logging.info(`${this.pageName} id was set to ${pageId}`);
        this.pageId = pageId;
    }

    /**
     * Sets the callback function.
     * @param callback A function that will execute when the web page button is pressed.
     */
    public setCallback(callback: any) {
        this.callback = callback;
    }
}