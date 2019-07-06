// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
import { NodeServer } from '../../../nodeServer';
import { NodeHttpAction, SoftTrigger } from '../index';
import { Rule } from '../rule';

/**
 * An extended class of Rule. The TriggerHttpCallback class is used to simplify creating softTriggers
 * that target the express server from the@type{NodeSerer} class.
 * @class
 */
export class TriggerHttpCallback extends Rule {
    private nodeHttpAction: NodeHttpAction;
    private softTrigger: SoftTrigger;

    /**
     * Constructor - instantiate everything
     * @param {NodeServer} nodeServer - nodeServer to register callback
     * @param {string} id - id use for route, don't use spaces
     * @param {string} text - text for the soft trigger
     * @param {string} icon - icon for the soft trigger
     * @param callback - callback function
     */
    constructor(nodeServer: NodeServer, id: string, text: string, icon: string, callback: any) {
        super(id);

        // configuring http action handler
        this.nodeHttpAction = new NodeHttpAction(nodeServer, `trigger_${id}`, callback);

        // configuring soft trigger to call the http action
        this.softTrigger = new SoftTrigger(text, icon);

        this.on(this.softTrigger).do(this.nodeHttpAction);
    }
}