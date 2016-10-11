'use strict';
/* eslint no-underscore-dangle: ["error", { "allowAfterThis": true }] */
const Breaker = require('circuit-fuses');
const Github = require('github');
const Scm = require('screwdriver-scm-base');
const Cache = require('node-cache');
const MATCH_URL_BRANCH_NAME = 4;
const MATCH_URL_REPO_NAME = 3;
const MATCH_URL_USER_NAME = 2;
const MATCH_URL_HOST_NAME = 1;
const MATCH_ID_BRANCH_NAME = 3;
const MATCH_ID_REPO_ID = 2;
const MATCH_ID_HOST_NAME = 1;
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
const REGEX_SSH_URL = /^git@([^:]+):([^\/]+)\/(.+?)\.git(#.+)?$/;
const REGEX_GIT_URL = /^(?:git|https):\/\/([^:]+)\/([^\/]+)\/(.+?)\.git(#.+)?$/;
const REGEX_REPO_ID = /^([^:]+):([^:]+):([^:]+)$/;

/**
* Get repo information
* @method getInfo
* @param  {String} scmUrl      URL of the repo OR repo identifier
* @param  {String} token
* @return {Object}             An object with the user, repo, and branch
*/
function getInfo(scmUrl) {
    return new Promise((resolve, reject) => {
        let matched;

        matched = REGEX_SSH_URL.exec(scmUrl);
        if (!matched) {
            matched = REGEX_GIT_URL.exec(scmUrl);
        }

        if (!matched) {
            return reject(`Invalid Url: ${scmUrl}`);
        }

        const branch = matched[MATCH_URL_BRANCH_NAME] || '#master';

        return resolve({
            user: matched[MATCH_URL_USER_NAME],
            repo: matched[MATCH_URL_REPO_NAME],
            host: matched[MATCH_URL_HOST_NAME],
            branch: branch.slice(1)
        });
    });
}

class GithubScm extends Scm {
    /**
    * Github command to run
    * @method _githubCommand
    * @param  {Object}   options            An object that tells what command & params to run
    * @param  {String}   options.action     Github method. For example: get
    * @param  {String}   options.token      Github token used for authentication of requests
    * @param  {Object}   options.params     Parameters to run with
    * @param  {Function} callback           Callback function from github API
    */
    _githubCommand(options, callback) {
        this.github.authenticate({
            type: 'oauth',
            token: options.token
        });

        this.github.repos[options.action](options.params, callback);
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
        this.cache = new Cache({
            // 60 second default timeout
            stdTTL: 60
        });

        // eslint-disable-next-line no-underscore-dangle
        this.breaker = new Breaker(this._githubCommand.bind(this), {
            retry: config.retry,
            breaker: config.breaker
        });
    }

    _lookupRepo(config) {
        // Check cache first
        const cacheKey = `repo|${config.scmUrl}`;
        const cached = this.cache.get(cacheKey);

        if (cached) {
            return Promise.resolve(cached);
        }

        return getInfo(config.scmUrl)
            .catch(() => (new Promise((resolve, reject) => {
                const matched = REGEX_REPO_ID.exec(config.scmUrl);

                if (!matched) {
                    return reject(new Error(`No known format matching ${config.scmUrl}`));
                }

                return this.breaker.runCommand({
                    action: 'getById',
                    token: config.token,
                    params: {
                        id: matched[MATCH_ID_REPO_ID]
                    }
                }, (error, data) => {
                    if (error) {
                        return reject(new Error(`No repository found matching ${config.scmUrl}`));
                    }

                    return resolve({
                        user: data.owner.login,
                        repo: data.name,
                        host: matched[MATCH_ID_HOST_NAME],
                        branch: matched[MATCH_ID_BRANCH_NAME]
                    });
                });
            })
            .then(repo => {
                this.cache.set(cacheKey, repo);

                return repo;
            })
        ));
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
        return this._lookupRepo(config)
            .then((repoInfo) => (
                new Promise((resolve, reject) => {
                    this.breaker.runCommand({
                        action: 'get',
                        token: config.token,
                        params: {
                            user: repoInfo.user,
                            repo: repoInfo.repo
                        }
                    }, (error, data) => {
                        if (error) {
                            return reject(error);
                        }

                        return resolve(data.permissions);
                    });
                })
            )
        );
    }

    /**
     * Get a commit sha for a specific repo#branch
     * @method getCommitSha
     * @param  {Object}   config            Configuration
     * @param  {String}   config.scmUrl     The scmUrl to get commit sha of
     * @param  {String}   config.token      The token used to authenticate to the SCM
     * @param  {String}   [config.ref]      Reference to get the SHA from (defaults to branch)
     * @return {Promise}
     */
    _getCommitSha(config) {
        return this._lookupRepo(config)
            .then((repoInfo) => (
                new Promise((resolve, reject) => {
                    this.breaker.runCommand({
                        action: 'getReference',
                        token: config.token,
                        params: {
                            user: repoInfo.user,
                            repo: repoInfo.repo,
                            ref: config.ref || `heads/${repoInfo.branch}`
                        }
                    }, (error, data) => {
                        if (error) {
                            return reject(error);
                        }

                        return resolve(data.commit.sha);
                    });
                })
            )
        );
    }

    /**
    * Update the commit status for a given repo and sha
    * @method updateCommitStatus
    * @param  {Object}   config              Configuration
    * @param  {String}   config.scmUrl       ScmUrl to get permissions on
    * @param  {String}   config.token        Token used to authenticate to the SCM
    * @param  {String}   config.sha          Sha to apply the status to
    * @param  {String}   config.buildStatus  Build status used for figuring out the commit status to set
    * @param  {String}   config.jobName      Name of the job that finished
    * @param  {String}   [config.url]        Optional target url
    * @return {Promise}
    */
    _updateCommitStatus(config) {
        return this._lookupRepo(config)
            .then((repoInfo) => (
                new Promise((resolve, reject) => {
                    const params = {
                        user: repoInfo.user,
                        repo: repoInfo.repo,
                        sha: config.sha,
                        state: STATE_MAP[config.buildStatus] || 'failure',
                        description: DESCRIPTION_MAP[config.buildStatus] || 'failure',
                        context: `Screwdriver/${config.jobName}`
                    };

                    if (config.url) {
                        params.target_url = config.url;
                    }

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
                })
            )
        );
    }

    /**
    * Fetch content of a file from github
    * @method getFile
    * @param  {Object}   config              Configuration
    * @param  {String}   config.scmUrl       ScmUrl to get permissions on
    * @param  {String}   config.token        Token used to authenticate to the SCM
    * @param  {String}   config.path         File in the repo to fetch
    * @param  {String}   [config.ref]        Reference to the SCM, either branch or sha
    * @return {Promise}
    */
    _getFile(config) {
        return this._lookupRepo(config)
            .then((repoInfo) => (
                new Promise((resolve, reject) => {
                    this.breaker.runCommand({
                        action: 'getContent',
                        token: config.token,
                        params: {
                            user: repoInfo.user,
                            repo: repoInfo.repo,
                            path: config.path,
                            ref: config.ref || repoInfo.branch
                        }
                    }, (error, data) => {
                        if (error) {
                            return reject(error);
                        }

                        if (data.type !== 'file') {
                            return reject(new Error(`Path ${config.path} does not point to file`));
                        }

                        return resolve(new Buffer(data.content, data.encoding).toString());
                    });
                })
            )
        );
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
            url: branchUrl,
            clone: repoInfo.clone_url
        }));
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
}

module.exports = GithubScm;
