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
import * as wordWrap from "word-wrap"

// A list of PR numbers that should be monitored for green status and merged
// when they reach it (unless mergeability is not possible).
const monitoredPRs: number[] = []

async function greenMerge(prNumber: number, prUrl: string) {
    // fetch PR
    let response = await axios.get(prUrl)
    let pr: PullRequest = response.data

    let commitBody = 
        wordWrap(
            pr.title + "\n\n" +
                // If there's a horizontal rule, only include the content before the rule.
                pr.body.match(/^---[-\s]*$/m) ?
                    pr.body.split(/^---[-\s]*$/m)[0].trim() :
                    pr.body,
            { width: 72 }
        );
    
    if (pr.mergeable == true && pr.mergeable_state == MergeStateStatus.Clean) {
        try {
            let mergeResult = await axios.put(
                `${pr.url}/merge`,
                { 
                    commit_title: `Merge pull request #${pr.number} from ${pr.base.repo.full_name}`,
                    commit_message: commitBody,
                    sha: pr.head.sha
                }
            )

            // Comment success!
        } catch (error) {
            // 405 Method not allowed
            // {
            //   "message": "Pull Request is not mergeable",
            //   "documentation_url": "https://developer.github.com/v3/pulls/#merge-a-pull-request-merge-button"
            // }
            // 409 Conflict
            // {
            //   "message": "Head branch was modified. Review and try the merge again.",
            //   "documentation_url": "https://developer.github.com/v3/pulls/#merge-a-pull-request-merge-button"
            // }
        }
    } else if (pr.mergeable == false) {
        // comment that the PR isn't mergeable
    } else if (pr.mergeable_state == MergeStateStatus.Blocked) {
        // comment that the PR merge is blocked
    } else 
        // may be missing an edge case, but:
        monitoredPRs.push(prNumber)
    }
}

function runThenMerge(prNumber: number, job: string) {
    // fetch PR
    //
    // Circle CI: POST /project/:vcs-type/:username/:project/build?circle_token=:token
    // {
    //     revision: mergeHeadRevision,
    //     build_parameters: { // for a specific job
    //       "CIRCLE_JOB": job
    //     }
    // }
}

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
    closed_at: string?,
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
    author_association: AuthorAssociation?,

    url: string,
    html_url: string,
}

function setUpHooks(robot: any) {
    let greenMergeRegExp = new RegExp("merge on green"),
        runMergeRegExp = new RegExp("run ([^ ]+) and merge");
    // fetch username
    //   new RegExp(`@${username}.*merge on green.*`)
    //

    let router: IRouter = robot.router
    router.get('/github/pull_request/comment', (req, res) => {
        let comment: IssueComment = req.body.comment,
            issue: Issue = req.body.issue;

        if (comment.author_association == AuthorAssociation.Contributor ||
                comment.author_association == AuthorAssociation.Collaborator) {
            let match: RegExpMatchArray | null = null
            if (comment.body.match(greenMergeRegExp)) {
                greenMerge(issue.number, issue.url)

                res.status(200)
                    .send('Triggering merge on green.')
            } else if (match = comment.body.match(runMergeRegExp)) {
                let job = match[1]
                runThenMerge(issue.number, job)

                res.status(200)
                    .send(`Attempting to trigger job [${job}] then merge on green.`)
            } else {
                res.status(200)
                    .send('No action detected.')
            }
        } else {
            res.status(200)
                .send('Author not authorized to trigger an action.')
        }
    })
}

exports = setUpHooks