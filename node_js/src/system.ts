// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
declare const Promise: any;
import { EventRuleManager, MediaserverApi, Rule, WebPageManager, BaseWebPage } from './index';
import { factory } from './logConfig';

const logging = factory.getLogger('System');

/**
 * Represents a system.
 * @class
 */
export class System extends MediaserverApi {
    public webPageManager: WebPageManager; // Helps manage web pages on the system and in the code.
    public ruleManager: EventRuleManager; // Helps manage rules on the system and in the code.
    public cameras: any = [];

    /**
     * @param {string} systemUrl
     * @param {string} username
     * @param {string} password
     * @param {{[p: string]: string}} configRules Rules from the config file.
     * @param {{[p: string]: string}} configPages Web pages from the config file.
     * @constructor
     */
    constructor(systemUrl: string, username: string, password: string,
                configRules: { [key: string]: string }, configPages?: { [key: string]: string },
                serverVersion?: string) {
        super(systemUrl, username, password, serverVersion);
        this.ruleManager = new EventRuleManager({ configRules });
        logging.info(`${configPages}`);
        this.webPageManager = new WebPageManager({ configPages });
        logging.info('Server is ready');
    }

    /**
     * Gets the rules from the system and sets them in the rule manager.
     * @return {Bluebird<WebPageManager>}
     */
    public getSystemPages() {
        return this.getWebPages().then((pages: any) => {
            return this.webPageManager.setPageIds(pages);
        });
    }

    /**
     * Gets the rules from the system and sets them in the rule manager.
     * @return {Bluebird<EventRuleManager>}
     */
    public getSystemRules() {
        return this.getRules().then((rules: any) => {
            return this.ruleManager.setRulesIds(rules);
        });
    }

    /**
     * Enables or disables a rule.
     * @param {Rule} rule
     * @param {boolean} state
     */
    public disableRule(rule: Rule, state: boolean) {
        rule.config({ disabled: state, id: rule.ruleId });
        this.saveRule(rule).then(() => {
            logging.info(`${rule.comment} is now ${state ? 'disabled' : 'enabled' }`);
        });
    }

    /**
     * Saves the rule to the system or sets the id of an already existing rule.
     * @param {Rule} rule
     * @return {any}
     */
    public saveRuleToSystem(rule: Rule) {
        const ruleId = this.ruleManager.ruleExists(rule);
        if (ruleId !== '') {
            rule.ruleId = ruleId;
            return Promise.resolve(rule);
        } else {
            return this.saveRule(rule);
        }
    }

    /**
     * Saves a web page to the system.
     * @param {BaseWebPage} webpage
     */
    public saveWebPageToSystem(webpage: BaseWebPage) {
        const pageId = this.webPageManager.pageExists(webpage);
        return this.saveWebPage(pageId, webpage.pageName, webpage.url);
    }
}
