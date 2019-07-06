// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
import * as request from 'request-promise';
import * as crypto from 'crypto';
import { BaseEvent, Rule } from './index';
import { factory } from './logConfig';

const logging = factory.getLogger('Mediaserver Api');

/**
 * A class that uses some basic api calls to interact with a Server.
 * @class
 */
export class MediaserverApi {
    /** The IP address and port of the target Server. */
    public systemUrl: string;
    private serverVersion: string;
    private cookieJar: any;
    private auth: string;
    protected user: string;
    protected password: string;

    /**
     * @param {string} systemUrl Ip address and port of the target system.
     * @param {string} username Valid username on the system.
     * @param {string} password Password belonging to that user.
     * @param {string} serverVersion
     * @constructor
     */
    constructor(systemUrl: string, username: string, password: string, serverVersion?: string) {
        logging.info('Building api system');
        this.cookieJar = request.jar();
        this.user = username;
        this.password = password;
        this.systemUrl = systemUrl;
        this.auth = "";
        this.serverVersion = serverVersion || "4";
    }

    /**
     * Logs relevant information about parameters for this class.
     */
    public display() {
        logging.info(() => JSON.stringify({
            systemUrl: this.systemUrl,
            user: this.user
        }));
    }

    /**
     * Authenticates the user using the cookie login method.
     * @return {void}
     */
    public login() {
        return this.getNonce().then((res: any) => {
            return this.cookieLogin(this.user, this.password, res.realm, res.nonce);
        }).then((res: any) => {
            logging.info('Login complete');
            return;
        })
    }

    /**
     * Pings the system to check if its active and gets general information about it.
     * @return {Bluebird<void>}
     */
    public ping() {
        return this.getWrapper('/api/moduleInformation')
                .then((res: any) => {
                    logging.info(res.reply);
                });
    }

    /**
     * Gets the system's settings.
     * @return {Bluebird<void>}
     */
    public getSystemSettings() {
        return this.getWrapper('/ec2/getSettings')
                .then((res: any) => {
                    logging.info(res);
                }, (err: any) => {
                    logging.error(err);
                });
    }

    /**
     * Gets all of the cameras from system.
     * @return {Bluebird<void>}
     */
    public getCameras() {
        return this.getWrapper('/ec2/getCamerasEx', {})
                .then((cameras: any) => {
                    return cameras;
                }, (err: any) => {
                    logging.error(err);
                    return [];
                });
    }

    /**
     * Gets the rules currently on the system and saves the rule ids.
     * If a ruleId is passed into this method it returns that rule.
     * @param {string} ruleId Id of a rule
     * @return {Bluebird<any>}
     */
    public getRules(ruleId?: string) {
        const qs: object = ruleId !== undefined ? { id: ruleId } : {};
        return this.getWrapper('/ec2/getEventRules', qs)
                .then((rules: any) => {
                    return ruleId === undefined ? rules : rules[0];
                });
    }

    /**
     * Gets the web pages currently on the system and saves the web page ids.
     * @return {Bluebird<any>}
     */
    public getWebPages() {
        return this.getWrapper('/ec2/getWebPages');
    }

    /**
     * Saves a rule to the system.
     * @param {Rule} rule The rule you are trying to save to a system.
     * @return {any}
     */
    public saveRule(rule: Rule) {
        return this.postWrapper('/ec2/saveEventRule', rule.makeRuleJson())
                .then((res: any) => {
                    rule.ruleId = res.body.id;
                    return rule;
                }, (err: any) => {
                    logging.error(err);
                    return undefined;
                });
    }

    /**
     * Saves a web page to the system.
     * @param {string} id The id of the web page.
     * @param {string} name The name of the web page.
     * @param {string} url The url that the web page opens to.
     * @return {any}
     */
    public saveWebPage(id: string, name: string, url: string) {
        return this.postWrapper('/ec2/saveWebPage', {id, name, url})
            .then((res: any) => {
                logging.info(`WebPage saved: {id:${id}, name:${name}, url:${url} was sent to ${this.systemUrl}`);
                logging.info(`${JSON.stringify(res)}`);
                return res.body.id;
            }, (err: any) => {
                logging.error('Error in saving webpage');
                return undefined;
            });
    }

    /**
     * Sends an event to system. Currently only supports generic events.
     * @param {BaseEvent} event The event you want to trigger on the server.
     * @param {Date} timestamp The timestamp of when the event occurred.
     * @param {string} state Describes if the event started or stopped.
     *     Values can be '', 'Active', 'Inactive'.
     * @return {Bluebird<void>}
     */
    public sendEvent({ event, timestamp, state }: {
        event: BaseEvent, timestamp?: Date, state?: string
    }) {
        const queryString: { [key: string]: any } = event.formatQueryString();
        if (timestamp !== undefined) {
            queryString.timestamp = timestamp;
        }
        if (state !== undefined) {
            queryString.state = state;
        }
        return this.getWrapper('/api/createEvent', queryString).then((res: any) => {
            logging.info(`Event with ${JSON.stringify(queryString)} was sent to ${this.systemUrl}`);
        }, (err: any) => {
            logging.error(err);
        });
    }

    /**
     * Gets all of the names, emails, and ids of users in the system.
     * @return {Bluebird<any>}
     */
    public getUsers() {
        return this.getWrapper('/ec2/getUsers')
                .then((users: any) => {
                    return users.map((user: { [key: string]: string }) => {
                        return { name: user.name, email: user.email, id: user.id };
                    });
                }, (err: any) => {
                    logging.error(err);
                    return err.name;
                });
    }

    /**
     * Removes a user from the system by a user's id.
     * @param {string} userid
     * @return {Bluebird<void>}
     */
    public removeUser(userid: string) {
        return this.postWrapper('/ec2/removeUser', { id: userid })
                .then((res: any) => {
                    logging.info('Success', res);
                }, (err: any) => {
                    logging.error(err);
                });
    }

    /**
     * A GET request wrapper. First, tries to use cookies for auth. Then, falls back to using auth in querystring.
     * Finally, it uses basic auth as a last resort.
     * @param {string} target
     * @param {object} qs
     * @return {Bluebird<any>}
     */
    public getWrapper(target: string, qs?: {[key: string]: any}) {
        return this.requestWrapper({
            jar: this.cookieJar,
            qs: (qs),
            rejectUnauthorized: false,
            url: `${this.systemUrl}${target}`
        });
    }

    /**
     * A POST request wrapper. First, tries to use cookies for auth. Then, it uses basic auth as a last resort.
     * @param {string} target
     * @param {object} data
     * @return {Bluebird<any>}
     */
    public postWrapper(target: string, data?: object) {
        return this.requestWrapper({
            jar: this.cookieJar,
            json: data,
            method: 'POST',
            rejectUnauthorized: false,
            resolveWithFullResponse: true,
            url: `${this.systemUrl}${target}`
        });
    }

    /**
     * Makes the request use basic auth instead of the cookie.
     * @param basicRequest The options for sending a request.
     * @return {Bluebird<any>}
     */
    private basicAuthRequest(basicRequest: any) {
        basicRequest.url = basicRequest.url.replace('//', `//${this.user}:${this.password}@`);
        return request(basicRequest).then(this.makeObject);
    }

    /**
     * Attempts to login to the server using the cookie login.
     * @param {string} login The user's login.
     * @param {string} password The user's password.
     * @param {string} nonce The nonce for the Server.
     * @param {string} realm The realm for the Server.
     * @return {Bluebird<any>}
     */
    private cookieLogin(login: string, password: string, nonce: string, realm: string) {
        this.auth = this.makeAuth(login, password, nonce, realm);
        return this.postWrapper('/api/cookieLogin', {auth: this.auth});
    }

    /**
     * Gets the nonce for the Server.
     * @return {any}
     */
    private getNonce() {
        return this.getWrapper('/api/getNonce').then((response: any) => {
            const nonce = response.reply.nonce;
            const realm = response.reply.realm;
            return {nonce, realm};
        });
    }

    /**
     * Logs failed requests.
     * @param err A string or object that has an error.
     */
    private logRequestFailure(err: any) {
        logging.error(`${err}`);
    }

    /**
     * Generates a md5 hash for the input value.
     * @param {string} input A string that needs to be hashed.
     * @return {string}
     */
    private md5Digest(input: string) {
        return crypto.createHash('md5').update(input).digest('hex');
    }

    /**
     * Converts all of the system's responses to json.
     * @param response String or object.
     * @return {any}
     */
    private makeObject(response: any) {
        return typeof(response) === 'string' ? JSON.parse(response) : response;
    }

    /**
     * Generates the digest auth used for the cookieLogin api call.
     * @param {string} login The user's login.
     * @param {string} password The user's password.
     * @param {string} nonce The nonce for the Server.
     * @param {string} realm The realm for the Server.
     * @return {string}
     */
    private makeAuth(login: string, password: string, realm: string, nonce: string) {
        const digest = this.md5Digest(`${login}:${realm}:${password}`);
        const method = this.md5Digest('GET:');
        const authDigest = this.md5Digest(`${digest}:${nonce}:${method}`);
        return Buffer.from(`${login}:${nonce}:${authDigest}`).toString('base64');
    }

    /**
     * Wrapper for requests that handles different authentication methods between server versions.
     * @param serverRequest The options for sending a request.
     * @return {Bluebird<any>}
     */
    private requestWrapper(serverRequest: any) {
        switch (this.serverVersion) {
            case '3':
                return this.basicAuthRequest(serverRequest).catch(this.logRequestFailure);
            default:
                return request(serverRequest).then(this.makeObject).catch((err) => {
                    logging.error('Auth failed falling back to basic auth.');
                    this.serverVersion = '3';
                    return this.basicAuthRequest(serverRequest);
                }).catch(this.logRequestFailure);

        }
    }
}
