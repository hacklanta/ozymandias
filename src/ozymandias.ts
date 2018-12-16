// Ozymandias exposes a GitHub webhook for comments. It watches PR comments for
// two classes of requests:
//
//  - "merge on green" will monitor until the PR is "green" (approved with tests
//    passing). If the PR finishes all its status checks and is not ready to
//    merge, a comment will be left indicating the issue.
//  - "run <job> and merge" will run the requested Circle job and then merge on
//    green. As with "merge on green", a failing status check will trigger a
//    comment indicating the issue.
//
// Note: merges pull the PR description as Markdown directly into the merge
// commit. If there is a horizontal rule (a string of three or more `-` with
// blank lines on either side), only the content above the horizontal rule is
// pulled in.
import { IRouter, Response } from "express-serve-static-core"
import { default as axios } from "axios"
import wordWrap from "word-wrap";

// MergeAttempt represents a pending attempt to merge a PR. It contains the URL
// to the PR's API entry, alongside the timestamp for when the merge attempt was
// initiated.
type MergeAttempt = {
    prUrl: string,
    monitorStartTimestamp: number
}

// A list of MergeAttempts that should be monitored for green status and merged
// when they reach it (unless mergeability is not possible).
const monitoredAttempts: { [key: string]: MergeAttempt } = {}

const SECONDS = 1000,
      MINUTES = 60 * SECONDS,
      MONITOR_TIMEOUT = 60 * MINUTES;

async function greenMerge(attempt: MergeAttempt) {
    // Fetch PR.
    let response = await axios.get(attempt.prUrl)
    let pr: PullRequest = response.data
    let postComment = (comment: string) => {
        return axios.post(pr.comments_url, { body: comment })
    }

    // Check if we've outlasted our timeout.
    let now = (new Date()).getTime()
    if (now - attempt.monitorStartTimestamp > MONITOR_TIMEOUT) {
        postComment("Timed out after 60 minutes waiting to merge.")
    }

    let commitBody = 
        wordWrap(
            pr.title + "\n\n" +
                // If there's a horizontal rule, only include the content before the rule.
                pr.body.match(/^---[-\s]*$/m) ?
                    pr.body.split(/^---[-\s]*$/m)[0].trim() :
                    pr.body,
            { width: 72 }
        );

    try {
        if (pr.mergeable == true && pr.mergeable_state == MergeStateStatus.Clean) {
            try {
                // Even if the comment fails, merge.
                await axios.put(
                    `${pr.url}/merge`,
                    { 
                        commit_title: `Merge pull request #${pr.number} from ${pr.base.repo.full_name}`,
                        commit_message: commitBody,
                        sha: pr.head.sha
                    }
                )
            } catch (error) {
                let response = error.response,
                    status = response.status,
                    message = response.data.status,
                    url = response.data.documentation_url;

                if (status == 409) {
                    // GitHub's response is descriptive enough; post it directly.
                    postComment(message)
                } else if (url) {
                    postComment(`Unknown error merging PR: [${message}](${url}).`)
                } else if (message) {
                    postComment(`Unknown error merging PR: ${message}.`)
                } else {
                    postComment(`Unknown error merging PR: ${JSON.stringify(response.data)}.`)
                }
            }
        } else if (pr.mergeable === true && pr.mergeable_state != MergeStateStatus.Clean) {
            // Hacky-lacky, the PR gives us a statuses URL and we turn it into
            // the signular status URL that gives us a combined status for the
            // PR head.
            let statusResponse = await axios.get(pr.statuses_url.replace(/statuses/, 'status'))

            if (statusResponse.data.state == 'pending') {
                // Statuses are pending, wait for them to resolve.
                monitoredAttempts[attempt.prUrl] = attempt;
            } else if (statusResponse.data.state == 'success') {
                // Statuses are clean, yet mergeable state isn't; something else
                // is wrong, signal as much.
                postComment("Merge is blocked! Resolve the issue, then try again.")
            } else {
                // Statuses aren't clean or pending, stop trying to merge.
                postComment("One or more required status checks failed; aborting merge.")
            }
        } else if (pr.mergeable === false) { // null means not yet available
            postComment("PR is not mergeable! Resolve conflicts, then try again.")
        } else {
            // may be missing an edge case, but:
            monitoredAttempts[attempt.prUrl] = attempt;
        }
    } catch (error) {
        console.error(`Failed to update PR ${attempt.prUrl}: ${error}`)
    }
}

async function runThenMerge(
    runJob: (commit: string)=>Promise<any>,
    attempt: MergeAttempt
) {
    let response = await axios.get(attempt.prUrl),
        pr: PullRequest = response.data;

    // Wait for job running to complete successfully, then schedule the PR merge
    // attempt.
    await runJob(pr.head.sha)

    monitoredAttempts[attempt.prUrl] = attempt
}

// Association between CI provider name and a function that dispatches a request
// to run a job on that CI provider.
    // Circle CI: POST /project/:vcs-type/:username/:project/build?circle_token=:token
    // {
    //     revision: mergeHeadRevision,
    //     build_parameters: { // for a specific job
    //       "CIRCLE_JOB": job
    //     }
    // }

enum AuthorAssociation {
    Collaborator = 'COLLABORATOR',
    Contributor = 'CONTRIBUTOR',
    FirstTimer = 'FIRST_TIMER',
    FirstTimeContributor = 'FIRST_TIME_CONTRIBUTOR',
    Member = 'MEMBER',
    None = 'NONE',
    Owner = 'OWNER'
}

// Lives in mergeable_state field in the REST API, but the GraphQL type is
// called MergeableStateStatus.
enum MergeStateStatus {
    Behind = 'BEHIND',
    Blocked = 'BLOCKED',
    Clean = 'CLEAN',
    Dirty = 'DIRTY',
    HasHooks = 'HAS_HOOKS',
    Unknown = 'UNKNOWN',
    Unstable = 'UNSTABLE'
}

type User = {
    id: number,
    node_id: string

    login: string,
    avatar_url: string,
    gravatar_id: string,

    url: string,
    html_url: string
    follower_url: string,
    following_url: string,
    gists_url: string,
    starred_url: string,
    subscriptions_url: string,
    organizations_url: string,
    repos_url: string,
    events_url: string,
    received_events_url: string,

    type: string,
    site_admin: boolean,
}

type Label = {
    id: number,
    node_id: string,

    name: string,
    color: string,
    default: boolean,

    url: string,
}

enum IssueState {
    Open = "open",
    Closed = "closed",
}

type Issue = {
    id: number,
    node_id: string,

    number: number,
    title: string,
    body: string,

    user: User,
    labels: Label[],
    state: IssueState,
    locked: boolean,

    assignee: User,
    assignees: User[],
    milestone,
    comments: number

    created_at: string,
    updated_at: string,
    closed_at?: string,
    author_association?: AuthorAssociation,

    url: string,
    repository_url?: string,
    labels_url: string,
    comments_url: string,
    events_url: string,
    html_url: string,
}

type PullRequest = Issue & {
    mergeable: boolean,
    mergeable_state: MergeStateStatus,

    head: { sha: string, user: User, repo: { full_name: string } },
    base: { sha: string, user: User, repo: { full_name: string } },

    issue_url: string,
    review_comments_url: string,
    review_comment_url: string,
    commits_url: string,
    diff_url: string,
    patch_url: string,
    statuses_url: string,
}

type IssueComment = {
    id: number,
    node_id: string,

    body: string,
    user: User,

    created_at: string,
    updated_at: string,
    author_association?: AuthorAssociation,

    url: string,
    html_url: string,
}

// setUpHooks sets up the callback hooks on the router that allow GitHub to
// notify Ozymandias about a new comment. New comments are monitored for "merge
// on green" and "run <job> and merge". The former triggers Ozymandias to wait
// for a mergeable pull request and then merge it. The latter requests that a
// job be run on a CI provider and then waits for a mergeable pull request.
//
// Two things worth noting:
// - The CI provider is abstracted behind the `runJob` function, which takes a
//   job name and commit SHA and returns a Promise representing the result of
//   requesting that the job be run. If the Promise is successful, the job
//   submission is considered successful.
// - The CI provider is in charge of updating the commit status for the given
//   job.  Ozymandias only checks the PR and thus commit's status via the status
//   checks API, so if the provider doesn't update the commit status, Ozymandias
//   may merge the PR before the cited job finishes running.
function setUpHooks(router: IRouter, runJob: (repository: string, job: string, commit: string)=>Promise<any>) {
    let greenMergeRegExp = new RegExp("merge on green"),
        runMergeRegExp = new RegExp("run ([^ ]+) and merge");
    // fetch username?
    //   new RegExp(`@${username}.*merge on green.*`)
    //

    router.get('/github/pull_request/comment', (req, res) => {
        let comment: IssueComment = req.body.comment,
            issue: Issue = req.body.issue;

        if (comment.author_association == AuthorAssociation.Contributor ||
                comment.author_association == AuthorAssociation.Collaborator) {
            let match: RegExpMatchArray | null = null
            if (comment.body.match(greenMergeRegExp)) {
                res.status(200)
                    .send('Triggering merge on green.')

                greenMerge({
                    prUrl: issue.url,
                    monitorStartTimestamp: (new Date()).getTime()
                })
            } else if (match = comment.body.match(runMergeRegExp)) {
                let job = match[1],
                    // Hack attack, but let's not do an extra request to the
                    // repo root, which we'd have to construct ourselves anyway,
                    // to get the full repo name.
                    repoName = issue.repository_url.replace(/^.*repos\//, "");
                runThenMerge(
                    (commit: string) => runJob(repoName, job, commit),
                    {
                        prUrl: issue.url,
                        monitorStartTimestamp: (new Date()).getTime()
                    }
                )

                res.status(200)
                    .send(`Attempting to trigger job [${job}] then merge on green.`)
            } else {
                res.status(200)
                    .send('No action detected.')
            }
        } else {
            res.status(400)
                .send('Author not authorized to trigger an action.')
        }
    })
}

export default { setUpHooks };