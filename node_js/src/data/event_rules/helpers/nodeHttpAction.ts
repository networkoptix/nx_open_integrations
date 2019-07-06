// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
import config from '../../../config';
import { NodeServer } from '../../../nodeServer';
import { HttpAction } from '../index';

/**
 * An extended class of HttpAction. The NodeHttpAction class is used to simplify making
 * rules that target the express server from the@type{NodeSerer} class.
 * @class
 */
export class NodeHttpAction extends HttpAction {
    /**
     * The express server that executes callback functions.
     */
    public nodeServer: NodeServer;

    /**
     * @param {NodeServer} nodeServer
     * @param {string} target The target route on the express server.
     * @param callback The callback function that executes for the express route.
     * @constructor
     */
    constructor(nodeServer: NodeServer, target?: string, callback?: any) {
        super();
        this.nodeServer = nodeServer;

        if (target !== undefined && callback !== undefined) {
            this.configDefaultHandler(target, callback);
        }
    }

    /**
     * Allows you to provide a route parameter and callback function. Then it adds the callback
     * function to the default route handler with the route parameter as a key on the express server.
     * @param {string} routeParam The route parameter for the default route handler
     *     on the express server.
     * @param {function} callback The callback function that executes for the express route.
     */
    public configDefaultHandler(routeParam: string, callback: any) {
        this.actionParams.url = `${this.nodeServer.address}/${config.defaultExpressRoute}/${routeParam}`;
        this.nodeServer.addHttpCallback(routeParam, true, callback);
    }

    /**
     * Allows you to provide a target route and callback function, and adds the callback to a
     * custom route on the express server.
     * @param {string} target The target route on the express server.
     * @param {function} callback The callback function that executes for the express route.
     */
    public configCustomHandler(target: string, callback: any) {
        this.actionParams.url = `${this.nodeServer.address}/${target}`;
        this.nodeServer.addHttpCallback(target, false, callback);
    }
}
