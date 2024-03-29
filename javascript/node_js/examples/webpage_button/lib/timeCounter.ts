// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

import { Counter } from './counter';
import { ButtonWebPageManager } from './buttonWebPageManager';
import { BaseWebPage, Logger, RuntimeConfigManager, System,
    GenericEvent, NodeHttpAction, SoftTrigger, Rule, NodeServer } from 'nx-node-integration';

import { TimeSeriesCollection, closestSample } from 'time-series-collection';


const logging = Logger.getLogger('Time Counter Web Page');

/**
 * TimeCounter counts number of increments per time window. For example - counts people during last minute
 */
export class TimeCounter extends Counter {
    private eventCollection: TimeSeriesCollection<boolean>;
    private timeWindow: number;
    private static updateInterval = 1000;
    private interval: any;


    /**
     * Creates all the necessary web page buttons and saves them on the Server.
     * @param buttonWebPageManager Helps to save the counter to the media server.
     * @param server The Server where the counter will be created.
     * @param runtimeConfigManager Checks if the counter needs to be created on the target server.
     * @param nodeServer The node server that renders the counter.
     * @param id A unique identifier for the counter object.
     * @param captionPrefix The caption that is shown for the generic event.
     * @param timeWindow Defines how long to keep the records.
     * @param buttonIncrement Creates a web page button to increment the counter value.
     * @param buttonReset Creates a web page button to reset the counter value.
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
                id: string, captionPrefix = '', timeWindow = 60000,
                buttonIncrement = true, buttonReset = true,
                triggerIncrement = true, triggerReset = true,
                sendEvent = true, callback: any, getColorCallback: any) {

        super(buttonWebPageManager, server, runtimeConfigManager, nodeServer, id, captionPrefix,
            false, buttonIncrement, buttonReset,
            false, triggerIncrement, triggerReset,
            sendEvent, callback, getColorCallback);

        this.timeWindow = timeWindow;

        // instantiate a collection
        this.eventCollection = new TimeSeriesCollection<boolean>(closestSample());

        // Running interval to clean value if needed
        this.interval = setInterval(() => {
                this.updateTimeSeriesCollection();
            }, TimeCounter.updateInterval);
    }


    /**
     * Override increment logic - instead of increasing value - we register new event
     */
    protected incrementCounter() {
        this.updateTimeSeriesCollection(true);
    }

    /**
     * Timeseries logic - clean old records, add new if needed
     * @param increment
     */
    private updateTimeSeriesCollection(increment = false) {
        const oldValue = this.eventCollection.size();
        // Add new record
        const now = Date.now();

        // Forget records which are too old
        this.eventCollection.removeOutsideTimeFrame(now - this.timeWindow, now, false);

        if (increment) {
            this.eventCollection.addSample(now, true);
        }

        const newValue = this.eventCollection.size();
        if (newValue !== oldValue) {
            // Send actual value to the counter only if needed
            this.updateValue(newValue);
        }
    }
}