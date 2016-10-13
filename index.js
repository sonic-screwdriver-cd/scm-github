'use strict';

const Breaker = require('circuit-fuses');
const Github = require('github');
const hoek = require('hoek');
const schema = require('screwdriver-data-schema');
const Scm = require('screwdriver-scm-base');
const MATCH_COMPONENT_BRANCH_NAME = 4;
const MATCH_COMPONENT_REPO_NAME = 3;
const MATCH_COMPONENT_USER_NAME = 2;
const MATCH_COMPONENT_HOST_NAME = 1;
const PART_OWNER_NAME = 0;
const PART_REPO_NAME = 1;
const PART_SCM_URI_BRANCH = 2;
const PART_SCM_URI_HOST = 0;
const STATE_MAP = {
    SUCCESS: 'success',
    RUNNING: 'pending',
    QUEUED: 'pending'
};
const DESCRIPTION_MAP = {
    SUCCESS: 'Everything looks good!',
    FAILURE: 'Did not work as expected.',
    ABORTED: 'Aborted mid-flight',
    RUNNING: 'Testing your code...',
    QUEUED: 'Looking for a place to park...'
};

/**
* Get repo information
* @method getInfo
* @param  {String} scmUrl      scmUrl of the repo
* @return {Object}             An object with the user, repo, and branch
*/
function getInfo(scmUrl) {
    const matched = (schema.config.regex.SCM_URL).exec(scmUrl);

    // Check if regex did not pass
    if (!matched) {
        throw new Error(`Invalid scmUrl: ${scmUrl}`);
    }

    const branch = matched[MATCH_COMPONENT_BRANCH_NAME] || '#master';

    return {
        user: matched[MATCH_COMPONENT_USER_NAME],
        repo: matched[MATCH_COMPONENT_REPO_NAME],
        host: matched[MATCH_COMPONENT_HOST_NAME],
        branch: branch.slice(1)
    };
}

class GithubScm extends Scm {
    /**
    * Github command to run
    * @method _githubCommand
    * @param  {Object}   options            An object that tells what command & params to run
    * @param  {String}   options.action     Github method. For example: get
    * @param  {String}   options.token      Github token used for authentication of requests
    * @param  {Object}   options.params     Parameters to run with
    * @param  {String}   [options.scopeType]  Type of request to make. Default is 'repos'
    * @param  {Function} callback           Callback function from github API
    */
    _githubCommand(options, callback) {
        this.github.authenticate({
            type: 'oauth',
            token: options.token
        });
        const scopeType = options.scopeType || 'repos';

        this.github[scopeType][options.action](options.params, callback);
    }

    /**
    * Constructor
    * @method constructor
    * @param  {Object} options           Configuration options
    * @param  {Object} options.retry     Configuration options for circuit breaker retries
    * @param  {Object} options.breaker   Configuration options for circuit breaker
    * @return {GithubScm}
    */
    constructor(config) {
        super();

        this.config = config;
        this.github = new Github();

        // eslint-disable-next-line no-underscore-dangle
        this.breaker = new Breaker(this._githubCommand.bind(this), {
            retry: config.retry,
            breaker: config.breaker
        });
    }

    /**
     * Look up a repo by SCM URI
     * @method lookupScmUri
     * @param  {Object}     config Config object
     * @param  {Object}     config.scmUri The SCM URI to look up relevant info
     * @param  {Object}     config.token  Service token to authenticate with Github
     * @return {Promise}                  Resolves to an object containing
     *                                    repository-related information
     */
    lookupScmUri(config) {
        const scmUriParts = config.scmUri.split(':');

        return new Promise((resolve, reject) => {
            this.breaker.runCommand({
                action: 'getById',
                token: config.token,
                params: { id: scmUriParts[1] }  // magic number
            }, (error, data) => {
                if (error) {
                    return reject(error);
                }

                const repoNameParts = data.full_name.split('/');

                return resolve({
                    branch: scmUriParts[PART_SCM_URI_BRANCH],
                    host: scmUriParts[PART_SCM_URI_HOST],
                    repo: repoNameParts[PART_REPO_NAME],
                    user: repoNameParts[PART_OWNER_NAME]
                });
            });
        });
    }

    /**
    * Format the scmUrl for the specific source control
    * @method formatScmUrl
    * @param {String}    scmUrl        Scm Url to format properly
    */
    formatScmUrl(scmUrl) {
        let result = scmUrl;
        const branchName = getInfo(result).branch;

        // Do not convert branch name to lowercase
        result = result.split('#')[0].toLowerCase().concat(`#${branchName}`);

        return result;
    }

    /**
     * Decorate the author based on the Github service
     * @method _decorateAuthor
     * @param  {Object}        config          Configuration object
     * @param  {Object}        config.token    Service token to authenticate with Github
     * @param  {Object}        config.username Username to query more information for
     * @return {Promise}
     */
    _decorateAuthor(config) {
        return new Promise((resolve, reject) => {
            this.breaker.runCommand({
                action: 'getForUser',
                scopeType: 'users',
                token: config.token,
                params: { user: config.username }
            }, (error, data) => {
                if (error) {
                    return reject(error);
                }

                return resolve({
                    avatar: data.avatar_url,
                    name: data.name,
                    username: data.login,
                    url: data.html_url
                });
            });
        });
    }

    /**
     * Decorate the commit based on the repository
     * @method _decorateCommit
     * @param  {Object}        config        Configuration object
     * @param  {Object}        config.scmUri SCM URI the commit belongs to
     * @param  {Object}        config.token  Service token to authenticate with Github
     * @return {[type]}               [description]
     */
    _decorateCommit(config) {
        return this.lookupScmUri({
            scmUri: config.scmUri,
            token: config.token
        }).then(scmInfo =>
            new Promise((resolve, reject) => {
                this.breaker.runCommand({
                    action: 'getCommit',
                    token: config.token,
                    params: {
                        owner: scmInfo.user,
                        repo: scmInfo.repo,
                        sha: config.sha
                    }
                }, (error, data) => {
                    if (error) {
                        return reject(error);
                    }

                    const commitInfo = data.commit;

                    return resolve({
                        author: {
                            avatar: data.author.avatar_url,
                            name: commitInfo.author.name,
                            url: data.author.html_url,
                            username: data.author.login
                        },
                        message: commitInfo.message,
                        url: `https://github.com/${scmInfo.user}/${scmInfo.repo}/tree/${config.sha}`
                    });
                });
            })
        );
    }

    /**
     * Decorate a given SCM URL with additional data to better display
     * related information. If a branch suffix is not provided, it will default
     * to the master branch
     * @method decorateUrl
     * @param  {Config}    config        Configuration object
     * @param  {String}    config.scmUri The scm uri, of the form git@github.com:owner/repo.git
     * @param  {String}    config.token  The scm url, of the form git@github.com:owner/repo.git
     * @return {Object}
     */
    _decorateUrl(config) {
        return this.lookupScmUri({
            scmUri: config.scmUri,
            token: config.token
        }).then((scmInfo) => {
            const baseUrl = `${scmInfo.host}/${scmInfo.user}/${scmInfo.repo}`;

            return {
                branch: scmInfo.branch,
                name: `${scmInfo.user}/${scmInfo.repo}`,
                url: `https://${baseUrl}/tree/${scmInfo.branch}`
            };
        });
    }

    /**
    * Get a users permissions on a repository
    * @method _getPermissions
    * @param  {Object}   config            Configuration
    * @param  {String}   config.scmUrl     The scmUrl to get permissions on
    * @param  {String}   config.token      The token used to authenticate to the SCM
    * @return {Promise}
    */
    _getPermissions(config) {
        const scmInfo = getInfo(config.scmUrl);

        return new Promise((resolve, reject) => {
            this.breaker.runCommand({
                action: 'get',
                token: config.token,
                params: {
                    user: scmInfo.user,
                    repo: scmInfo.repo
                }
            }, (error, data) => {
                if (error) {
                    return reject(error);
                }

                return resolve(data.permissions);
            });
        });
    }

    /**
     * Get a commit sha for a specific repo#branch
     * @method getCommitSha
     * @param  {Object}   config            Configuration
     * @param  {String}   config.scmUrl     The scmUrl to get commit sha of
     * @param  {String}   config.token      The token used to authenticate to the SCM
     * @return {Promise}
     */
    _getCommitSha(config) {
        const scmInfo = getInfo(config.scmUrl);

        return new Promise((resolve, reject) => {
            this.breaker.runCommand({
                action: 'getBranch',
                token: config.token,
                params: scmInfo
            }, (error, data) => {
                if (error) {
                    return reject(error);
                }

                return resolve(data.commit.sha);
            });
        });
    }

    /**
    * Update the commit status for a given repo and sha
    * @method updateCommitStatus
    * @param  {Object}   config              Configuration
    * @param  {String}   config.scmUrl       The scmUrl to get permissions on
    * @param  {String}   config.sha          The sha to apply the status to
    * @param  {String}   config.buildStatus  The build status used for figuring out the commit status to set
    * @param  {String}   config.token        The token used to authenticate to the SCM
    * @param  {String}   [config.jobName]    Optional name of the job that finished
    * @param  {String}   [config.url]        Optional target url
    * @return {Promise}
    */
    _updateCommitStatus(config) {
        const scmInfo = getInfo(config.scmUrl);
        const context = config.jobName ? `Screwdriver/${config.jobName}` : 'Screwdriver';
        const params = {
            user: scmInfo.user,
            repo: scmInfo.repo,
            sha: config.sha,
            state: STATE_MAP[config.buildStatus] || 'failure',
            description: DESCRIPTION_MAP[config.buildStatus] || 'failure',
            context
        };

        if (config.url) {
            params.target_url = config.url;
        }

        return new Promise((resolve, reject) => {
            this.breaker.runCommand({
                action: 'createStatus',
                token: config.token,
                params
            }, (error, data) => {
                if (error) {
                    return reject(error);
                }

                return resolve(data);
            });
        });
    }

    /**
    * Fetch content of a file from github
    * @method getFile
    * @param  {Object}   config              Configuration
    * @param  {String}   config.scmUrl       The scmUrl to get permissions on
    * @param  {String}   config.path         The file in the repo to fetch
    * @param  {String}   config.token        The token used to authenticate to the SCM
    * @param  {String}   config.ref          The reference to the SCM, either branch or sha
    * @return {Promise}
    */
    _getFile(config) {
        const scmInfo = getInfo(config.scmUrl);

        return new Promise((resolve, reject) => {
            this.breaker.runCommand({
                action: 'getContent',
                token: config.token,
                params: {
                    user: scmInfo.user,
                    repo: scmInfo.repo,
                    path: config.path,
                    ref: config.ref || scmInfo.branch
                }
            }, (error, data) => {
                if (error) {
                    return reject(error);
                }

                if (data.type !== 'file') {
                    return reject(new Error(`Path (${config.path}) does not point to file`));
                }

                const contents = new Buffer(data.content, data.encoding).toString();

                return resolve(contents);
            });
        });
    }

    /**
    * Retrieve stats for the executor
    * @method stats
    * @param  {Response} Object          Object containing stats for the executor
    */
    stats() {
        return {
            requests: {
                total: this.breaker.getTotalRequests(),
                timeouts: this.breaker.getTimeouts(),
                success: this.breaker.getSuccessfulRequests(),
                failure: this.breaker.getFailedRequests(),
                concurrent: this.breaker.getConcurrentRequests(),
                averageTime: this.breaker.getAverageRequestTime()
            },
            breaker: {
                isClosed: this.breaker.isClosed()
            }
        };
    }

    /**
     * Get data for a specific repo
     * @method _getRepoInfo
     * @param  {Object}   scmInfo        The result of getScmInfo
     * @param  {String}   token          The token used to authenticate to the SCM
     * @return {Promise}                 Resolves to the result object of GitHub repository API
     */
    _getRepoInfo(scmInfo, token) {
        return new Promise((resolve, reject) => {
            this.breaker.runCommand({
                action: 'get',
                token,
                params: scmInfo
            }, (error, repoInfo) => {
                if (error) {
                    return reject(error);
                }

                return resolve(repoInfo);
            });
        });
    }

    /**
     * Get a url for a specific branch
     * @method _getBranchUrl
     * @param  {Object}    scmInfo       The result of getScmInfo
     * @param  {String}    token         The token used to authenticate to the SCM
     * @return {Promise}                 Resolves to the url of the specified branch in the scmInfo
     */
    _getBranchUrl(scmInfo, token) {
        return new Promise((resolve, reject) => {
            this.breaker.runCommand({
                action: 'getBranch',
                token,
                params: scmInfo
            }, (error, branchInfo) => {
                if (error) {
                    return reject(error);
                }

                // eslint-disable-next-line no-underscore-dangle
                return resolve(branchInfo._links.html);
            });
        });
    }

    /**
     * Get repository object for storing new pipeline
     * @method _getRepoId
     * @param  {Object}    config        Configuration
     * @param  {String}    config.scmUrl The scmUrl to get permissions on
     * @param  {String}    config.token  The token used to authenticate to the SCM
     * @return {Promise}
     */
    _getRepoId(config) {
        const scmInfo = getInfo(config.scmUrl);

        return Promise.all([
            // eslint-disable-next-line no-underscore-dangle
            this._getRepoInfo(scmInfo, config.token),
            // eslint-disable-next-line no-underscore-dangle
            this._getBranchUrl(scmInfo, config.token)
        ]).then(([repoInfo, branchUrl]) => ({
            id: `${scmInfo.host}:${repoInfo.id}:${scmInfo.branch}`,
            name: repoInfo.full_name,
            url: branchUrl
        }));
    }

    /**
     * Given a SCM webhook payload & its associated headers, aggregate the
     * necessary data to execute a Screwdriver job with.
     *
     * Temporary shiv until 2.0 is implemented
     * @method parseHook
     * @param  {Object}  payloadHeaders  The request headers associated with the
     *                                   webhook payload
     * @param  {Object}  webhookPayload  The webhook payload received from the
     *                                   SCM service.
     * @return {Promise}
     */
    parseHook(payloadHeaders, webhookPayload) {
        return new Promise((resolve, reject) => {
            try {
                // eslint-disable-next-line no-underscore-dangle
                const result = this._parseHook(payloadHeaders, webhookPayload);

                return resolve(result);
            } catch (e) {
                return reject(e);
            }
        });
    }

    /**
     * Given a SCM webhook payload & its associated headers, aggregate the
     * necessary data to execute a Screwdriver job with.
     * @method parseHook
     * @param  {Object}  payloadHeaders  The request headers associated with the
     *                                   webhook payload
     * @param  {Object}  webhookPayload  The webhook payload received from the
     *                                   SCM service.
     * @return {Object}                  A key-map of data related to the received
     *                                   payload
     */
    _parseHook(payloadHeaders, webhookPayload) {
        const type = payloadHeaders['x-github-event'];
        const checkoutUrl = hoek.reach(webhookPayload, 'repository.ssh_url');

        switch (type) {
        case 'pull_request': {
            let action = hoek.reach(webhookPayload, 'action');
            const prNum = hoek.reach(webhookPayload, 'pull_request.number');

            if (action === 'synchronize') {
                action = 'synchronized';
            }

            return {
                action,
                branch: hoek.reach(webhookPayload, 'pull_request.base.ref'),
                checkoutUrl,
                prNum,
                prRef: `${checkoutUrl}#pull/${prNum}/merge`,
                sha: hoek.reach(webhookPayload, 'pull_request.head.sha'),
                type: 'pr',
                username: hoek.reach(webhookPayload, 'pull_request.user.login')
            };
        }
        case 'push':
            return {
                action: 'push',
                branch: hoek.reach(webhookPayload, 'ref').replace(/^refs\/heads\//, ''),
                checkoutUrl: hoek.reach(webhookPayload, 'repository.ssh_url'),
                sha: hoek.reach(webhookPayload, 'after'),
                type: 'repo',
                username: hoek.reach(webhookPayload, 'sender.login')
            };
        default:
            throw new Error(`Event ${type} not supported`);
        }
    }

    /**
     * Parses a SCM URL into a screwdriver-representable ID
     *
     * 'token' is required, since it is necessary to lookup the SCM ID by
     * communicating with said SCM service.
     * @method parseUrl
     * @param  {Object} config              Config object
     * @param  {String} config.checkoutUrl  The checkout URL to parse
     * @param  {String} config.token        The token used to authenticate to the SCM service
     * @return {Promise}                    Resolves to an ID of 'serviceName:repoId:branchName'
     */
    parseUrl(config) {
        const scmInfo = getInfo(config.checkoutUrl);

        // eslint-disable-next-line no-underscore-dangle
        return this._getRepoInfo(scmInfo, config.token)
        .then(repoInfo =>
            `${scmInfo.host}:${repoInfo.id}:${scmInfo.branch}`
        );
    }
}

module.exports = GithubScm;
