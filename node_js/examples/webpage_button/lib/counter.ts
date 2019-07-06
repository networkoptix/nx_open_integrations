// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

import { BaseWebPage, Logger, RuntimeConfigManager, System,
    GenericEvent, NodeHttpAction, SoftTrigger, Rule, NodeServer } from 'nx-node-integration';
import { ButtonColors, ButtonWebPage } from './buttonWebPage';
import { ButtonWebPageManager } from './buttonWebPageManager';

const logging = Logger.getLogger('Counter Web Page');

/**
 * An example of a web page button that can show its current value, increment/decrement its value,
 * or reset its value.
 * @class
 */
export class Counter {
    private counterWebPage: ButtonWebPage;
    private incrementWebPage: ButtonWebPage|null;
    private decrementWebPage: ButtonWebPage|null;
    private resetWebPage: ButtonWebPage|null;
    private captionPrefix: string;
    private buttonWebPageManager: ButtonWebPageManager;
    private genericEvent: any;
    private server: System;
    private id: string;

    protected value = 0;
    protected callback: any;
    private sendEvent: boolean;
    private getColorCallback: any;

    /**
     * Creates all the necessary web page buttons and saves them on the Server.
     * @param buttonWebPageManager Helps to save the counter to the media server.
     * @param server The media server where the counter will be created.
     * @param runtimeConfigManager Checks if the counter needs to be created on the target server.
     * @param nodeServer The node server that renders the counter.
     * @param id The unique identifier for the counter object.
     * @param captionPrefix The caption that is shown for the generic event.
     * @param buttonDecrement Creates a web page button to decrement the counter value.
     * @param buttonIncrement Creates a web page button to increment the counter value.
     * @param buttonReset Creates a web page button to reset the counter value.
     * @param triggerDecrement Creates a soft trigger to decrement the counter value.
     * @param triggerIncrement Creates a soft trigger to increment the counter value.
     * @param triggerReset Creates a soft trigger to reset the counter value.
     * @param sendEvent If any of the soft trigger or web page buttons are pressed, send a generic
     *    event to the Server.
     * @param callback The callback to fire whenever the counter value is changed.
     * @param getColorCallback A callback for changing the color of the counter.
     * @constructor
     */
    constructor(buttonWebPageManager: ButtonWebPageManager, server: System, runtimeConfigManager: RuntimeConfigManager,
                nodeServer: NodeServer,
                id: string, captionPrefix = '',
                buttonDecrement = true, buttonIncrement = true, buttonReset = true,
                triggerDecrement = true, triggerIncrement = true, triggerReset = true,
                sendEvent = true, callback?: any, getColorCallback?: any) {
        this.server = server;
        this.buttonWebPageManager = buttonWebPageManager;
        this.genericEvent = new GenericEvent(`${id} counter`);
        this.callback = callback;
        this.getColorCallback = getColorCallback;
        this.id = id;
        this.value = 0;
        this.incrementWebPage = null;
        this.decrementWebPage = null;
        this.resetWebPage = null;

        // Counter value - no callback, just informer
        this.captionPrefix = captionPrefix;
        this.counterWebPage = new ButtonWebPage(`${id}counter`, `${id} counter`, '');
        let color = '';
        if (this.getColorCallback) {
            color = this.getColorCallback(this.value);
        }
        this.counterWebPage.configButton({
            showIcon: false,
            text: `${this.captionPrefix}${this.value}`,
            state: `${this.value}`,
            color: color
        });

        this.buttonWebPageManager.addButtonPage(this.counterWebPage);
        this.sendEvent = sendEvent;

        if (buttonReset || triggerReset) {
            this.resetWebPage = new ButtonWebPage(`${id}_reset`,
                `${id} reset`,
                '',
                `${id}`,
                ButtonColors.red,
                'fa-times'
                );
            this.resetWebPage.setCallback(() => {
                this.updateValue(0);
            });
            if (buttonReset) { // this is a hack - usually we should not create webpage object if button is false
                this.buttonWebPageManager.addButtonPage(this.resetWebPage);
            }
            if (triggerReset) {
                this.buttonWebPageManager.createSoftTriggerForButton(this.resetWebPage, SoftTrigger.Icons._lock_locked,
                    nodeServer, server);
            }
        }

        if (buttonIncrement || triggerIncrement) {
            this.incrementWebPage = new ButtonWebPage(`${id}_increment`,
                `${id} increment`,
                '',
                `${id}`,
                ButtonColors.brand,
                'fa-plus'
                );
            this.incrementWebPage.setCallback(() => {
               this.incrementCounter();
            });

            if (buttonIncrement) {
                this.buttonWebPageManager.addButtonPage(this.incrementWebPage);
            }
            if (triggerIncrement) {
                this.buttonWebPageManager.createSoftTriggerForButton(this.incrementWebPage, SoftTrigger.Icons._simple_plus,
                    nodeServer, server);
            }
        }

        if (buttonDecrement || triggerDecrement) {
            this.decrementWebPage = new ButtonWebPage(`${id}_decrement`,
                `${id} decrement`,
                '',
                `${id}`,
                ButtonColors.brand,
                'fa-minus'
                );
            this.decrementWebPage.setCallback(() => {
                this.decrementCounter();
            });

            if (buttonDecrement) {
                this.buttonWebPageManager.addButtonPage(this.decrementWebPage);
            }
            if (triggerDecrement) {
                this.buttonWebPageManager.createSoftTriggerForButton(this.decrementWebPage, SoftTrigger.Icons._simple_minus,
                    nodeServer, server);
            }
        }
    }

    public setCallback(callback: (value: number) => void) {
        this.callback = callback;
    }

    /**
     * Updates the value of the counter, the appearance of the button, and sends a generic event.
     * @param value The number the counter will be set to.
     */
    public updateValue(value: number) {
        this.value = value;
        if (this.callback) {
            this.callback(this.value);
        }
        let color = '';
        if (this.getColorCallback) {
            color = this.getColorCallback(this.value);
        }
        this.counterWebPage.configButton({text: `${this.captionPrefix}${this.value}`, state: `${this.value}`, color: color});
        this.server.saveWebPageToSystem(this.counterWebPage);
        if (this.sendEvent) {
            this.genericEvent.config({caption: `New ${this.id} value: ${this.value}`, description: `${this.value}`});
            this.server.sendEvent({event: this.genericEvent});
        }
    }

    protected incrementCounter() {
       this.updateValue(this.value + 1);
    }

    protected decrementCounter() {
       this.updateValue(this.value - 1);
    }
}