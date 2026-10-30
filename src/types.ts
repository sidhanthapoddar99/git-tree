/* Git Interfaces / Types */

export interface GitCommit {
	readonly hash: string;
	readonly parents: ReadonlyArray<string>;
	readonly author: string;
	readonly email: string;
	readonly date: number;
	readonly message: string;
	readonly heads: ReadonlyArray<string>;
	readonly tags: ReadonlyArray<GitCommitTag>;
	readonly remotes: ReadonlyArray<GitCommitRemote>;
	readonly stash: GitCommitStash | null; // null => not a stash, otherwise => stash info
	readonly worktree?: string; // Only set on a row of uncommitted changes in another worktree: the path of that worktree
	readonly host?: string; // Only set on a row of uncommitted changes in a remote host's worktree: the host's name (`worktree` is then the path on the server)
	readonly hostBranches?: ReadonlyArray<GitCommitHostBranch>; // The remote hosts' branches at this commit. Absent => none.
}

export interface GitCommitHostBranch {
	readonly host: string; // The host's name
	readonly name: string; // The branch's name on the host. The label is `<host>/<name>`.
}

export interface GitCommitTag {
	readonly name: string;
	readonly annotated: boolean;
}

export interface GitCommitRemote {
	readonly name: string;
	readonly remote: string | null; // null => remote not found, otherwise => remote name
}

export interface GitCommitStash {
	readonly selector: string;
	readonly baseHash: string;
	readonly untrackedFilesHash: string | null;
}

export interface GitCommitDetails {
	readonly hash: string;
	readonly parents: ReadonlyArray<string>;
	readonly author: string;
	readonly authorEmail: string;
	readonly authorDate: number;
	readonly committer: string;
	readonly committerEmail: string;
	readonly committerDate: number;
	readonly signature: GitSignature | null;
	readonly body: string;
	readonly fileChanges: ReadonlyArray<GitFileChange>;
}

export const enum GitSignatureStatus {
	GoodAndValid = 'G',
	GoodWithUnknownValidity = 'U',
	GoodButExpired = 'X',
	GoodButMadeByExpiredKey = 'Y',
	GoodButMadeByRevokedKey = 'R',
	CannotBeChecked = 'E',
	Bad = 'B'
}

export interface GitSignature {
	readonly key: string;
	readonly signer: string;
	readonly status: GitSignatureStatus;
}

export const enum GitConfigLocation {
	Local = 'local',
	Global = 'global',
	System = 'system'
}

export interface GitFileChange {
	readonly oldFilePath: string;
	readonly newFilePath: string;
	readonly type: GitFileStatus;
	readonly additions: number | null;
	readonly deletions: number | null;
}

export const enum GitFileStatus {
	Added = 'A',
	Modified = 'M',
	Deleted = 'D',
	Renamed = 'R',
	Untracked = 'U'
}

export const enum GitPushBranchMode {
	Normal = '',
	Force = 'force',
	ForceWithLease = 'force-with-lease'
}

export interface GitRepoConfig {
	readonly branches: GitRepoConfigBranches;
	readonly diffTool: string | null;
	readonly guiDiffTool: string | null;
	readonly pushDefault: string | null;
	readonly remotes: ReadonlyArray<GitRepoSettingsRemote>;
	readonly user: {
		readonly name: {
			readonly local: string | null,
			readonly global: string | null
		},
		readonly email: {
			readonly local: string | null,
			readonly global: string | null
		}
	};
}

export type GitRepoConfigBranches = { [branchName: string]: GitRepoConfigBranch };

export interface GitRepoConfigBranch {
	readonly pushRemote: string | null;
	readonly remote: string | null;
}

export interface GitRepoSettingsRemote {
	readonly name: string;
	readonly url: string | null;
	readonly pushUrl: string | null;
}

export const enum GitResetMode {
	Soft = 'soft',
	Mixed = 'mixed',
	Hard = 'hard'
}

export interface GitStash {
	readonly hash: string;
	readonly baseHash: string;
	readonly untrackedFilesHash: string | null;
	readonly selector: string;
	readonly author: string;
	readonly email: string;
	readonly date: number;
	readonly message: string;
}

export interface GitTagDetails {
	readonly hash: string;
	readonly taggerName: string;
	readonly taggerEmail: string;
	readonly taggerDate: number;
	readonly message: string;
	readonly signature: GitSignature | null;
}

export interface GitWorktree {
	readonly path: string;
	readonly name: string; // The folder name of the worktree, used as its label
	readonly head: string | null; // null => the worktree has no commits yet
	readonly branch: string | null; // null => detached HEAD
	readonly isMain: boolean; // Is the main worktree of the repository
	readonly isCurrent: boolean; // Is the worktree of the repository being viewed
	readonly locked: boolean;
	readonly prunable: boolean; // The worktree's folder no longer exists
	readonly host?: string; // The name of the remote host the worktree is on (`.worktrees/git-tree.yaml`). Absent => this machine.
	readonly hostCommitIsLocal?: boolean; // Only on a remote host's worktree: its HEAD commit is in this repository. FALSE => it can't be drawn, so the view says the commit isn't on this machine.
}

/**
 * The state of a remote host, from its last refresh:
 * - `ok`: read, and its branches fetched.
 * - `loading`: not read yet since Git Tree started.
 * - `needsConsent`: read, but its branches aren't fetched until the user agrees to the first fetch.
 * - `unreachable`: SSH couldn't connect, or timed out.
 * - `needsAuthentication`: SSH needs a password, a passphrase or a host key confirmation.
 * - `notARepository`: the path isn't a Git repository on the server, or Git is missing there.
 * - `differentRepository`: the server's repository shares no root commit with this one.
 * - `configError`: the host's entry in the config is invalid.
 */
export type GitRemoteHostState = 'ok' | 'loading' | 'needsConsent' | 'unreachable' | 'needsAuthentication' | 'notARepository' | 'differentRepository' | 'configError';

export interface GitRemoteHost {
	readonly name: string; // The host's name in the config, shown in the graph
	readonly ssh: string; // The SSH alias
	readonly path: string; // The path of the repository's main worktree on the server
	readonly state: GitRemoteHostState;
	readonly message: string | null; // What went wrong, in words, for every state but `ok` and `loading`
	readonly lastRefresh: number | null; // When the last good refresh finished (milliseconds since 1970). NULL => none yet.
}

/** A remote host's entry in `.worktrees/git-tree.yaml`, as the Remote Hosts panel edits it. */
export interface RemoteHostEntry {
	readonly name: string;
	readonly ssh: string; // A Host alias from the SSH configuration
	readonly path: string; // The absolute path of the repository's main worktree on the server
	readonly worktrees: boolean; // TRUE => the server's linked worktrees are shown too, FALSE => only its main worktree
	readonly forwardAgent: boolean; // TRUE => Git commands that Git Tree runs on the server (clone, fetch, pull, push) get the local SSH agent (ssh -A), so they can reach GitHub as the user
}

/** A remote host as the Remote Hosts panel shows it: its entry, and its state from the last refresh. */
export interface GitRemoteHostSettings extends RemoteHostEntry {
	readonly state: GitRemoteHostState;
	readonly message: string | null;
	readonly lastRefresh: number | null;
	readonly worktreeCount: number; // The worktrees read in the last good refresh
}

/** A Host alias from the SSH configuration (~/.ssh/config, and the files it includes). */
export interface SshAlias {
	readonly alias: string;
	readonly hostName: string | null; // `HostName`, NULL => not set (ssh connects to the alias itself)
	readonly user: string | null; // `User`, NULL => not set
}

/** A folder on a server, as the folder browser of the Remote Hosts panel lists it. */
export interface RemoteFolderEntry {
	readonly name: string;
	readonly kind: 'folder' | 'repository' | 'worktree'; // A repository's main worktree, a linked worktree, or any other folder
}

/** Where a new repository on a server gets its commits: a clone of one of this repository's remotes, made on the server, or a push of this repository's branches. */
export type RemoteRepositorySource = { readonly kind: 'clone', readonly remote: string } | { readonly kind: 'push' };

/**
 * GitCommit rows in the compact form the extension posts to the webview: each (name, email) once, and each parent in the
 * rows as its index. `encodeCommits` (src/compactCommits.ts) builds it, and `decodeCommits` (web/compactCommits.ts) reads it.
 */
export interface CompactCommits {
	readonly people: ReadonlyArray<string>; // Pair k is people[2k] (name) and people[2k + 1] (email)
	readonly rows: ReadonlyArray<CompactCommit>;
}

/**
 * One GitCommit: [hash, parents, person, date, message, heads, tags, remotes, stash, worktree, host, hostBranches]. A parent
 * in the rows is its index in them, and a parent outside them is its hash. The optional fields are left out from the end of
 * the row while they are empty or NULL (or, for the worktree and the host, missing), so most rows have only the first five.
 */
export type CompactCommit = readonly [string, ReadonlyArray<number | string>, number, number, string, ReadonlyArray<string>?, ReadonlyArray<CompactCommitTag>?, ReadonlyArray<CompactCommitRemote>?, (CompactCommitStash | null)?, (string | null)?, (string | null)?, ReadonlyArray<CompactCommitHostBranch>?];
export type CompactCommitTag = readonly [string, 0 | 1]; // [name, annotated]
export type CompactCommitRemote = readonly [string, string | null]; // [name, remote]
export type CompactCommitStash = readonly [string, string, string | null]; // [selector, baseHash, untrackedFilesHash]
export type CompactCommitHostBranch = readonly [string, string]; // [host, name]


/* Git Repo State */

export interface CodeReview {
	id: string;
	lastActive: number;
	lastViewedFile: string | null;
	remainingFiles: string[];
}

export type ColumnWidth = number;

export type GitRepoSet = { [repo: string]: GitRepoState };

export interface IssueLinkingConfig {
	readonly issue: string;
	readonly url: string;
}

export interface PullRequestConfigBase {
	readonly hostRootUrl: string;
	readonly sourceRemote: string;
	readonly sourceOwner: string;
	readonly sourceRepo: string;
	readonly destRemote: string | null;
	readonly destOwner: string;
	readonly destRepo: string;
	readonly destProjectId: string; // Only used by GitLab
	readonly destBranch: string;
}

export const enum PullRequestProvider {
	Bitbucket,
	Custom,
	GitHub,
	GitLab
}

interface PullRequestConfigBuiltIn extends PullRequestConfigBase {
	readonly provider: Exclude<PullRequestProvider, PullRequestProvider.Custom>;
	readonly custom: null;
}

interface PullRequestConfigCustom extends PullRequestConfigBase {
	readonly provider: PullRequestProvider.Custom;
	readonly custom: {
		readonly name: string,
		readonly templateUrl: string
	};
}

export type PullRequestConfig = PullRequestConfigBuiltIn | PullRequestConfigCustom;

export interface GitRepoState {
	cdvDivider: number;
	cdvHeight: number;
	columnWidths: ColumnWidth[] | null;
	commitOrdering: RepoCommitOrdering;
	fileViewType: FileViewType;
	hideHosts: string[]; // The remote hosts whose worktrees and branches the view leaves out
	hideRemotes: string[];
	hostChoice: HostChoice; // The Host dropdown's choice
	includeCommitsMentionedByReflogs: BooleanOverride;
	issueLinkingConfig: IssueLinkingConfig | null;
	lastImportAt: number;
	name: string | null;
	onlyFollowFirstParent: BooleanOverride;
	onRepoLoadShowCheckedOutBranch: BooleanOverride;
	onRepoLoadShowSpecificBranches: string[] | null;
	pullRequestConfig: PullRequestConfig | null;
	showRemoteBranches: boolean;
	showRemoteBranchesV2: BooleanOverride;
	showStashes: BooleanOverride;
	showTags: BooleanOverride;
	workspaceFolderIndex: number | null;
	worktreeChoice: string | null; // The Worktree dropdown's choice: a worktree's path, or a remote host's worktree's key. NULL => All
}


/* Git Tree View Types */

export interface GitTreeViewInitialState {
	readonly config: GitTreeViewConfig;
	readonly lastActiveRepo: string | null;
	readonly loadViewTo: LoadGitTreeViewTo;
	readonly repos: GitRepoSet;
	readonly loadRepoInfoRefreshId: number;
	readonly loadCommitsRefreshId: number;
}

export interface GitTreeViewConfig {
	readonly commitDetailsView: CommitDetailsViewConfig;
	readonly commitOrdering: CommitOrdering;
	readonly contextMenuActionsVisibility: ContextMenuActionsVisibility;
	readonly customBranchGlobPatterns: ReadonlyArray<CustomBranchGlobPattern>;
	readonly customEmojiShortcodeMappings: ReadonlyArray<CustomEmojiShortcodeMapping>;
	readonly customPullRequestProviders: ReadonlyArray<CustomPullRequestProvider>;
	readonly dateFormat: DateFormat;
	readonly defaultColumnVisibility: DefaultColumnVisibility;
	readonly dialogDefaults: DialogDefaults;
	readonly enhancedAccessibility: boolean;
	readonly fetchAndPrune: boolean;
	readonly fetchAndPruneTags: boolean;
	readonly fetchAvatars: boolean;
	readonly graph: GraphConfig;
	readonly includeCommitsMentionedByReflogs: boolean;
	readonly initialLoadCommits: number;
	readonly keybindings: KeybindingConfig
	readonly loadMoreCommits: number;
	readonly loadMoreCommitsAutomatically: boolean;
	readonly markdown: boolean;
	readonly mute: MuteCommitsConfig;
	readonly onlyFollowFirstParent: boolean;
	readonly onRepoLoad: OnRepoLoadConfig;
	readonly referenceLabels: ReferenceLabelsConfig;
	readonly repoDropdownOrder: RepoDropdownOrder;
	readonly showRemoteBranches: boolean;
	readonly showStashes: boolean;
	readonly showTags: boolean;
	readonly worktreeDefaultLocation: string;
}

export interface GitTreeViewGlobalState {
	alwaysAcceptCheckoutCommit: boolean;
	issueLinkingConfig: IssueLinkingConfig | null;
	pushTagSkipRemoteCheck: boolean;
}

export interface GitTreeViewWorkspaceState {
	findIsCaseSensitive: boolean;
	findIsRegex: boolean;
	findOpenCommitDetailsView: boolean;
}

export interface CommitDetailsViewConfig {
	readonly autoCenter: boolean;
	readonly fileTreeCompactFolders: boolean;
	readonly fileViewType: FileViewType;
	readonly location: CommitDetailsViewLocation;
}

export interface GraphConfig {
	readonly colours: ReadonlyArray<string>;
	readonly coloursLight: ReadonlyArray<string>; // The colours used on light themes, in the same order as `colours`
	readonly style: GraphStyle;
	readonly grid: { x: number, y: number, offsetX: number, offsetY: number, expandY: number };
	readonly uncommittedChanges: GraphUncommittedChangesStyle;
}

export interface KeybindingConfig {
	readonly find: string | null;
	readonly refresh: string | null;
	readonly scrollToHead: string | null;
	readonly scrollToStash: string | null;
}

export type LoadGitTreeViewTo = {
	readonly repo: string,
	readonly commitDetails?: {
		readonly commitHash: string,
		readonly compareWithHash: string | null
	},
	readonly runCommandOnLoad?: 'fetch'
} | null;

export interface MuteCommitsConfig {
	readonly commitsNotAncestorsOfHead: boolean;
	readonly mergeCommits: boolean;
}

export interface OnRepoLoadConfig {
	readonly scrollToHead: boolean;
	readonly showCheckedOutBranch: boolean;
	readonly showSpecificBranches: ReadonlyArray<string>;
}

export interface ReferenceLabelsConfig {
	readonly branchLabelsAlignedToGraph: boolean;
	readonly combineLocalAndRemoteBranchLabels: boolean;
	readonly tagLabelsOnRight: boolean;
}


/* Extension Settings Types */

export const enum BooleanOverride {
	Default,
	Enabled,
	Disabled
}

export const enum CommitDetailsViewLocation {
	Inline,
	DockedToBottom
}

export const enum CommitOrdering {
	Date = 'date',
	AuthorDate = 'author-date',
	Topological = 'topo'
}

export interface ContextMenuActionsVisibility {
	readonly branch: {
		readonly checkout: boolean;
		readonly rename: boolean;
		readonly delete: boolean;
		readonly merge: boolean;
		readonly rebase: boolean;
		readonly push: boolean;
		readonly viewIssue: boolean;
		readonly createPullRequest: boolean;
		readonly createArchive: boolean;
		readonly selectInBranchesDropdown: boolean;
		readonly unselectInBranchesDropdown: boolean;
		readonly copyName: boolean;
	};
	readonly commit: {
		readonly addTag: boolean;
		readonly createBranch: boolean;
		readonly checkout: boolean;
		readonly cherrypick: boolean;
		readonly revert: boolean;
		readonly drop: boolean;
		readonly merge: boolean;
		readonly rebase: boolean;
		readonly reset: boolean;
		readonly copyHash: boolean;
		readonly copySubject: boolean;
	};
	readonly commitDetailsViewFile: {
		readonly viewDiff: boolean;
		readonly viewFileAtThisRevision: boolean;
		readonly viewDiffWithWorkingFile: boolean;
		readonly openFile: boolean;
		readonly markAsReviewed: boolean;
		readonly markAsNotReviewed: boolean;
		readonly resetFileToThisRevision: boolean;
		readonly copyAbsoluteFilePath: boolean;
		readonly copyRelativeFilePath: boolean;
	};
	readonly remoteBranch: {
		readonly checkout: boolean;
		readonly delete: boolean;
		readonly fetch: boolean;
		readonly merge: boolean;
		readonly pull: boolean;
		readonly viewIssue: boolean;
		readonly createPullRequest: boolean;
		readonly createArchive: boolean;
		readonly selectInBranchesDropdown: boolean;
		readonly unselectInBranchesDropdown: boolean;
		readonly copyName: boolean;
	};
	readonly stash: {
		readonly apply: boolean;
		readonly createBranch: boolean;
		readonly pop: boolean;
		readonly drop: boolean;
		readonly copyName: boolean;
		readonly copyHash: boolean;
	};
	readonly tag: {
		readonly viewDetails: boolean;
		readonly delete: boolean;
		readonly push: boolean;
		readonly createArchive: boolean;
		readonly copyName: boolean;
	};
	readonly uncommittedChanges: {
		readonly stash: boolean;
		readonly reset: boolean;
		readonly clean: boolean;
		readonly openSourceControlView: boolean;
	};
}

export interface CustomBranchGlobPattern {
	readonly name: string;
	readonly glob: string;
}

export interface CustomEmojiShortcodeMapping {
	readonly shortcode: string;
	readonly emoji: string;
}

export interface CustomPullRequestProvider {
	readonly name: string;
	readonly templateUrl: string;
}

export interface DateFormat {
	readonly type: DateFormatType;
	readonly iso: boolean;
}

export const enum DateFormatType {
	DateAndTime,
	DateOnly,
	Relative
}

export const enum DateType {
	Author,
	Commit
}

export interface DefaultColumnVisibility {
	readonly worktree: boolean;
	readonly host: boolean;
	readonly date: boolean;
	readonly author: boolean;
	readonly commit: boolean;
}

export interface DialogDefaults {
	readonly addTag: {
		readonly pushToRemote: boolean,
		readonly type: TagType
	};
	readonly applyStash: {
		readonly reinstateIndex: boolean
	};
	readonly cherryPick: {
		readonly noCommit: boolean,
		readonly recordOrigin: boolean
	};
	readonly createBranch: {
		readonly checkout: boolean
	};
	readonly deleteBranch: {
		readonly forceDelete: boolean
	};
	readonly fetchIntoLocalBranch: {
		readonly forceFetch: boolean
	};
	readonly fetchRemote: {
		readonly prune: boolean,
		readonly pruneTags: boolean
	};
	readonly general: {
		readonly referenceInputSpaceSubstitution: string | null
	};
	readonly merge: {
		readonly noCommit: boolean,
		readonly noFastForward: boolean,
		readonly squash: boolean
	};
	readonly popStash: {
		readonly reinstateIndex: boolean
	};
	readonly pullBranch: {
		readonly noFastForward: boolean,
		readonly squash: boolean
	};
	readonly rebase: {
		readonly ignoreDate: boolean,
		readonly interactive: boolean
	};
	readonly resetCommit: {
		readonly mode: GitResetMode
	};
	readonly resetUncommitted: {
		readonly mode: Exclude<GitResetMode, GitResetMode.Soft>
	};
	readonly stashUncommittedChanges: {
		readonly includeUntracked: boolean
	};
}

export const enum FileViewType {
	Default,
	Tree,
	List
}

export const enum GraphStyle {
	Rounded,
	Angular
}

export const enum GraphUncommittedChangesStyle {
	OpenCircleAtTheUncommittedChanges,
	OpenCircleAtTheCheckedOutCommit
}

export const enum RefLabelAlignment {
	Normal,
	BranchesOnLeftAndTagsOnRight,
	BranchesAlignedToGraphAndTagsOnRight
}

export const enum RepoCommitOrdering {
	Default = 'default',
	Date = 'date',
	AuthorDate = 'author-date',
	Topological = 'topo'
}

export const enum RepoDropdownOrder {
	FullPath,
	Name,
	WorkspaceFullPath
}

export const enum SquashMessageFormat {
	Default,
	GitSquashMsg
}

export const enum TabIconColourTheme {
	Colour,
	Grey
}

export const enum TagType {
	Annotated,
	Lightweight
}


/* Base Interfaces for Request / Response Messages */

export interface BaseMessage {
	readonly command: string;
}

export interface RepoRequest extends BaseMessage {
	readonly repo: string; // Git commands run here: the repository, or the worktree of it that the view shows
}

export interface ResponseWithErrorInfo extends BaseMessage {
	readonly error: ErrorInfo;
}

export interface ResponseWithMultiErrorInfo extends BaseMessage {
	readonly errors: ErrorInfo[];
}

export type ErrorInfo = string | null; // null => no error, otherwise => error message

export const enum ErrorInfoExtensionPrefix {
	PushTagCommitNotOnRemote = 'VSCODE_GIT_GRAPH:PUSH_TAG:COMMIT_NOT_ON_REMOTE:'
}

/* Request / Response Messages */

export interface RequestAddRemote extends RepoRequest {
	readonly command: 'addRemote';
	readonly name: string;
	readonly url: string;
	readonly pushUrl: string | null;
	readonly fetch: boolean;
}
export interface ResponseAddRemote extends ResponseWithErrorInfo {
	readonly command: 'addRemote';
}

export interface RequestLoadRemoteHosts extends RepoRequest {
	readonly command: 'loadRemoteHosts';
}
export interface ResponseLoadRemoteHosts extends ResponseWithErrorInfo {
	readonly command: 'loadRemoteHosts';
	readonly repo: string;
	readonly hosts: ReadonlyArray<GitRemoteHostSettings>;
	readonly configFile: string | null; // The path of .worktrees/git-tree.yaml, NULL => the repository has no main worktree (it's bare)
	readonly configError: string | null; // Why the file can't be used as a whole, NULL => it can, or it doesn't exist
	readonly sshAliases: ReadonlyArray<SshAlias>;
	readonly agentInstruction: string; // The instruction for coding agents, which the Copy button copies
}

export interface RequestBrowseRemoteHost extends RepoRequest {
	readonly command: 'browseRemoteHost';
	readonly ssh: string;
	readonly path: string | null; // NULL => the home folder on the server
}
export interface ResponseBrowseRemoteHost extends ResponseWithErrorInfo {
	readonly command: 'browseRemoteHost';
	readonly ssh: string;
	readonly path: string; // The absolute path that was listed (the request's path, or the home folder)
	readonly parent: string | null; // NULL => the path is the root
	readonly entries: ReadonlyArray<RemoteFolderEntry>; // Folders only, sorted by name
	readonly truncated: boolean; // TRUE => the folder holds more folders than Git Tree lists (2,000)
}

export interface RequestCheckRemoteHost extends RepoRequest {
	readonly command: 'checkRemoteHost';
	readonly ssh: string;
	readonly path: string;
}
export interface ResponseCheckRemoteHost extends ResponseWithErrorInfo {
	// error NULL => the path is the main worktree of a repository of this project. Otherwise it says what's wrong.
	readonly command: 'checkRemoteHost';
	readonly ssh: string;
	readonly path: string;
}

export interface RequestSaveRemoteHost extends RepoRequest {
	readonly command: 'saveRemoteHost';
	readonly previousName: string | null; // NULL => add a host, otherwise => replace the host with this name
	readonly host: RemoteHostEntry;
}
export interface ResponseSaveRemoteHost extends ResponseWithErrorInfo {
	readonly command: 'saveRemoteHost';
}

export interface RequestCreateRemoteHostRepository extends RepoRequest {
	readonly command: 'createRemoteHostRepository';
	readonly host: RemoteHostEntry; // `path` is the new repository's folder, which must be missing or empty
	readonly source: RemoteRepositorySource;
}
export interface ResponseCreateRemoteHostRepository extends ResponseWithErrorInfo {
	readonly command: 'createRemoteHostRepository';
}

export interface RequestRemoveRemoteHost extends RepoRequest {
	readonly command: 'removeRemoteHost';
	readonly name: string;
}
export interface ResponseRemoveRemoteHost extends ResponseWithErrorInfo {
	readonly command: 'removeRemoteHost';
}

export type RemoteHostGitAction = 'fetch' | 'pull' | 'push'; // `git fetch --all --prune`, `git pull --ff-only`, or `git push` of the checked-out branch

export interface RequestRunRemoteHostGit extends RepoRequest {
	readonly command: 'runRemoteHostGit';
	readonly host: string;
	readonly worktreePath: string; // The server worktree to run it in
	readonly action: RemoteHostGitAction;
}
export interface ResponseRunRemoteHostGit extends ResponseWithErrorInfo {
	readonly command: 'runRemoteHostGit';
	readonly host: string;
	readonly action: RemoteHostGitAction;
}

export interface RequestAddTag extends RepoRequest {
	readonly command: 'addTag';
	readonly commitHash: string;
	readonly tagName: string;
	readonly type: TagType;
	readonly message: string;
	readonly pushToRemote: string | null; // string => name of the remote to push the tag to, null => don't push to a remote
	readonly pushSkipRemoteCheck: boolean;
	readonly force: boolean;
}
export interface ResponseAddTag extends ResponseWithMultiErrorInfo {
	readonly command: 'addTag';
	readonly repo: string;
	readonly tagName: string;
	readonly pushToRemote: string | null;
	readonly commitHash: string;
}

export interface RequestAskRemoteHostFetchConsent extends RepoRequest {
	readonly command: 'askRemoteHostFetchConsent';
	readonly host: string; // The host's name
}
export interface ResponseAskRemoteHostFetchConsent extends ResponseWithErrorInfo {
	readonly command: 'askRemoteHostFetchConsent';
}

export interface RequestApplyStash extends RepoRequest {
	readonly command: 'applyStash';
	readonly selector: string;
	readonly reinstateIndex: boolean;
}
export interface ResponseApplyStash extends ResponseWithErrorInfo {
	readonly command: 'applyStash';
}

export interface RequestBranchFromStash extends RepoRequest {
	readonly command: 'branchFromStash';
	readonly selector: string;
	readonly branchName: string;
}
export interface ResponseBranchFromStash extends ResponseWithErrorInfo {
	readonly command: 'branchFromStash';
}

export interface RequestCheckoutBranch extends RepoRequest {
	readonly command: 'checkoutBranch';
	readonly branchName: string;
	readonly remoteBranch: string | null;
	readonly pullAfterwards: {
		readonly branchName: string;
		readonly remote: string;
		readonly createNewCommit: boolean;
		readonly squash: boolean;
	} | null; // NULL => Don't pull after checking out
}
export interface ResponseCheckoutBranch extends ResponseWithMultiErrorInfo {
	readonly command: 'checkoutBranch';
	readonly pullAfterwards: {
		readonly branchName: string;
		readonly remote: string;
	} | null; // NULL => Don't pull after checking out
}

export interface RequestCheckoutCommit extends RepoRequest {
	readonly command: 'checkoutCommit';
	readonly commitHash: string;
}
export interface ResponseCheckoutCommit extends ResponseWithErrorInfo {
	readonly command: 'checkoutCommit';
}

export interface RequestCherrypickCommit extends RepoRequest {
	readonly command: 'cherrypickCommit';
	readonly commitHash: string;
	readonly parentIndex: number;
	readonly recordOrigin: boolean;
	readonly noCommit: boolean;
}
export interface ResponseCherrypickCommit extends ResponseWithMultiErrorInfo {
	readonly command: 'cherrypickCommit';
}

export interface RequestCleanUntrackedFiles extends RepoRequest {
	readonly command: 'cleanUntrackedFiles';
	readonly directories: boolean;
}
export interface ResponseCleanUntrackedFiles extends ResponseWithErrorInfo {
	readonly command: 'cleanUntrackedFiles';
}

export interface RequestCommitDetails extends RepoRequest {
	readonly command: 'commitDetails';
	readonly commitHash: string;
	readonly hasParents: boolean;
	readonly stash: GitCommitStash | null; // null => request is for a commit, otherwise => request is for a stash
	readonly avatarEmail: string | null; // string => fetch avatar with the given email, null => don't fetch avatar
	readonly refresh: boolean;
}
export interface ResponseCommitDetails extends ResponseWithErrorInfo {
	readonly command: 'commitDetails';
	readonly repo: string; // Where the details were read: the request's repo. Every worktree's uncommitted changes have the same hash, so this says whose they are.
	readonly commitDetails: GitCommitDetails | null;
	readonly avatar: string | null;
	readonly codeReview: CodeReview | null;
	readonly refresh: boolean;
}

export interface RequestCompareCommits extends RepoRequest {
	readonly command: 'compareCommits';
	readonly commitHash: string;
	readonly compareWithHash: string;
	readonly fromHash: string;
	readonly toHash: string;
	readonly refresh: boolean;
}
export interface ResponseCompareCommits extends ResponseWithErrorInfo {
	readonly command: 'compareCommits';
	readonly commitHash: string;
	readonly compareWithHash: string;
	readonly fileChanges: ReadonlyArray<GitFileChange>;
	readonly codeReview: CodeReview | null;
	readonly refresh: boolean;
}

export interface RequestCopyFilePath extends RepoRequest {
	readonly command: 'copyFilePath';
	readonly filePath: string;
	readonly absolute: boolean;
}
export interface ResponseCopyFilePath extends ResponseWithErrorInfo {
	readonly command: 'copyFilePath';
}

export interface RequestCopyToClipboard extends BaseMessage {
	readonly command: 'copyToClipboard';
	readonly type: string;
	readonly data: string;
}
export interface ResponseCopyToClipboard extends ResponseWithErrorInfo {
	readonly command: 'copyToClipboard';
	readonly type: string;
}

export interface RequestCreateArchive extends RepoRequest {
	readonly command: 'createArchive';
	readonly ref: string;
}
export interface ResponseCreateArchive extends ResponseWithErrorInfo {
	readonly command: 'createArchive';
}

export interface RequestCreateBranch extends RepoRequest {
	readonly command: 'createBranch';
	readonly commitHash: string;
	readonly branchName: string;
	readonly checkout: boolean;
	readonly force: boolean;
}
export interface ResponseCreateBranch extends ResponseWithMultiErrorInfo {
	readonly command: 'createBranch';
}

export interface RequestCreateWorktree extends RepoRequest {
	readonly command: 'createWorktree';
	readonly path: string; // An absolute path, or a path relative to the main worktree
	readonly commitish: string; // The commit or branch to check out in the worktree
	readonly newBranch: string | null; // null => check out `commitish` without creating a branch
	readonly openInNewWindow: boolean;
}
export interface ResponseCreateWorktree extends ResponseWithMultiErrorInfo {
	readonly command: 'createWorktree';
}

/** Create a worktree on a remote host. `repo` is the repository. */
export interface RequestCreateRemoteWorktree extends RepoRequest {
	readonly command: 'createRemoteWorktree';
	readonly host: string; // The host's name
	readonly path: string; // An absolute path on the server, or a path relative to the host's main worktree
	readonly commitish: string; // The commit, or the host's branch, to check out in the worktree
	readonly newBranch: string | null; // null => check out `commitish` without creating a branch
	readonly openInNewWindow: boolean; // Open it with Remote-SSH once it is created
}
export interface ResponseCreateRemoteWorktree extends ResponseWithMultiErrorInfo {
	readonly command: 'createRemoteWorktree';
}

export interface RequestCreatePullRequest extends RepoRequest {
	readonly command: 'createPullRequest';
	readonly config: PullRequestConfig;
	readonly sourceRemote: string;
	readonly sourceOwner: string;
	readonly sourceRepo: string;
	readonly sourceBranch: string;
	readonly push: boolean;
}
export interface ResponseCreatePullRequest extends ResponseWithMultiErrorInfo {
	readonly command: 'createPullRequest';
	readonly push: boolean;
}

export interface RequestDeleteBranch extends RepoRequest {
	readonly command: 'deleteBranch';
	readonly branchName: string;
	readonly forceDelete: boolean;
	readonly deleteOnRemotes: ReadonlyArray<string>;
}
export interface ResponseDeleteBranch extends ResponseWithMultiErrorInfo {
	readonly command: 'deleteBranch';
	readonly repo: string;
	readonly branchName: string;
	readonly deleteOnRemotes: ReadonlyArray<string>;
}

export interface RequestDeleteRemote extends RepoRequest {
	readonly command: 'deleteRemote';
	readonly name: string;
}
export interface ResponseDeleteRemote extends ResponseWithErrorInfo {
	readonly command: 'deleteRemote';
}

export interface RequestDeleteRemoteBranch extends RepoRequest {
	readonly command: 'deleteRemoteBranch';
	readonly branchName: string;
	readonly remote: string;
}
export interface ResponseDeleteRemoteBranch extends ResponseWithErrorInfo {
	readonly command: 'deleteRemoteBranch';
}

export interface RequestDeleteTag extends RepoRequest {
	readonly command: 'deleteTag';
	readonly tagName: string;
	readonly deleteOnRemote: string | null; // null => don't delete on remote, otherwise => remote to delete on
}
export interface ResponseDeleteTag extends ResponseWithErrorInfo {
	readonly command: 'deleteTag';
}

export interface RequestDeleteUserDetails extends RepoRequest {
	readonly command: 'deleteUserDetails';
	readonly name: boolean; // TRUE => Delete Name, FALSE => Don't Delete Name
	readonly email: boolean; // TRUE => Delete Email, FALSE => Don't Delete Email
	readonly location: GitConfigLocation.Global | GitConfigLocation.Local;
}
export interface ResponseDeleteUserDetails extends ResponseWithMultiErrorInfo {
	readonly command: 'deleteUserDetails';
}

export interface RequestDropCommit extends RepoRequest {
	readonly command: 'dropCommit';
	readonly commitHash: string;
}
export interface ResponseDropCommit extends ResponseWithErrorInfo {
	readonly command: 'dropCommit';
}

export interface RequestDropStash extends RepoRequest {
	readonly command: 'dropStash';
	readonly selector: string;
}
export interface ResponseDropStash extends ResponseWithErrorInfo {
	readonly command: 'dropStash';
}

export interface RequestEditRemote extends RepoRequest {
	readonly command: 'editRemote';
	readonly nameOld: string;
	readonly nameNew: string;
	readonly urlOld: string | null;
	readonly urlNew: string | null;
	readonly pushUrlOld: string | null;
	readonly pushUrlNew: string | null;
}
export interface ResponseEditRemote extends ResponseWithErrorInfo {
	readonly command: 'editRemote';
}

export interface RequestEditUserDetails extends RepoRequest {
	readonly command: 'editUserDetails';
	readonly name: string;
	readonly email: string;
	readonly location: GitConfigLocation.Global | GitConfigLocation.Local;
	readonly deleteLocalName: boolean; // TRUE => Delete Local Name, FALSE => Don't Delete Local Name
	readonly deleteLocalEmail: boolean; // TRUE => Delete Local Email, FALSE => Don't Delete Local Email
}
export interface ResponseEditUserDetails extends ResponseWithMultiErrorInfo {
	readonly command: 'editUserDetails';
}

export interface RequestEndCodeReview extends RepoRequest {
	readonly command: 'endCodeReview';
	readonly id: string;
}

export interface RequestExportRepoConfig extends RepoRequest {
	readonly command: 'exportRepoConfig';
}
export interface ResponseExportRepoConfig extends ResponseWithErrorInfo {
	readonly command: 'exportRepoConfig';
}

export interface RequestFetch extends RepoRequest {
	readonly command: 'fetch';
	readonly name: string | null; // null => Fetch all remotes
	readonly prune: boolean;
	readonly pruneTags: boolean;
}
export interface ResponseFetch extends ResponseWithErrorInfo {
	readonly command: 'fetch';
}

export interface RequestFetchAvatar extends RepoRequest {
	readonly command: 'fetchAvatar';
	readonly remote: string | null;
	readonly email: string;
	readonly commits: string[];
}
export interface ResponseFetchAvatar extends BaseMessage {
	readonly command: 'fetchAvatar';
	readonly email: string;
	readonly image: string;
}

export interface RequestFetchIntoLocalBranch extends RepoRequest {
	readonly command: 'fetchIntoLocalBranch';
	readonly remote: string;
	readonly remoteBranch: string;
	readonly localBranch: string;
	readonly force: boolean;
}
export interface ResponseFetchIntoLocalBranch extends ResponseWithErrorInfo {
	readonly command: 'fetchIntoLocalBranch';
}

/**
 * The Host dropdown's choice. NULL => All: this machine's worktrees, and every remote host's but those hidden in Repository
 * Settings, including hosts added later. Otherwise the sources shown: '' for Local, this machine's worktrees (no host name
 * is empty), and the names of the remote hosts. An empty list shows no worktrees. Names of hosts the repository doesn't
 * have, or hides, are ignored, and a list of only such names counts as All.
 */
export type HostChoice = ReadonlyArray<string> | null;

export interface RequestLoadCommits extends RepoRequest {
	readonly command: 'loadCommits';
	readonly refreshId: number;
	readonly branches: ReadonlyArray<string> | null; // null => Show All
	readonly maxCommits: number;
	readonly showTags: boolean;
	readonly showRemoteBranches: boolean;
	readonly includeCommitsMentionedByReflogs: boolean;
	readonly onlyFollowFirstParent: boolean;
	readonly commitOrdering: CommitOrdering;
	readonly remotes: ReadonlyArray<string>;
	readonly hideRemotes: ReadonlyArray<string>;
	readonly hideHosts: ReadonlyArray<string>; // Remote hosts left out: their branches as start points, and their worktrees' rows
	readonly hostChoice: HostChoice; // Leaves out the remote hosts it doesn't show, as hideHosts does, and this machine's worktrees' rows when it doesn't show Local
	readonly stashes: ReadonlyArray<GitStash>;
	readonly worktrees: ReadonlyArray<GitWorktree>;
	readonly onlyWorktreeHistory: boolean; // TRUE => only the history of the worktree that repo is: its HEAD joins branches as a start point, and no other worktree's uncommitted changes are read
	readonly onlyHostWorktree: GitWorktree | null; // A remote host's worktree (one of `worktrees`) => only its history: its HEAD commit joins branches as a start point, if it is on this machine, and only its uncommitted changes are shown. Repo is then the repository.
	readonly token: string | null; // The token of the commits the view shows, from the response that loaded them. NULL => it shows none, or must get the full page
}
/**
 * The response to a RequestLoadCommits:
 * - The page of commits, as two lists of rows: the leading rows of uncommitted changes, and the history after them.
 * - `unchanged`: the request's token still describes the history, so only the rows of uncommitted changes are sent. The view keeps its history, head, tags, `moreCommitsAvailable` and `onlyFollowFirstParent`.
 */
export type ResponseLoadCommits = ResponseLoadCommitsPage | ResponseLoadCommitsUnchanged;
export interface ResponseLoadCommitsPage extends ResponseWithErrorInfo {
	readonly command: 'loadCommits';
	readonly refreshId: number;
	readonly unchanged: false;
	readonly uncommitted: CompactCommits; // The leading rows of uncommitted changes
	readonly commits: CompactCommits; // The rows after them
	readonly head: string | null;
	readonly tags: string[];
	readonly moreCommitsAvailable: boolean;
	readonly onlyFollowFirstParent: boolean;
	readonly token: string | null; // Describes the history, head, tags, moreCommitsAvailable and onlyFollowFirstParent. NULL => the commits couldn't be loaded
}
export interface ResponseLoadCommitsUnchanged extends ResponseWithErrorInfo {
	readonly command: 'loadCommits';
	readonly refreshId: number;
	readonly unchanged: true;
	readonly uncommitted: CompactCommits; // The leading rows of uncommitted changes
	readonly token: string; // The request's token
	readonly error: null;
}

export interface RequestLoadConfig extends RepoRequest {
	readonly command: 'loadConfig';
	readonly remotes: ReadonlyArray<string>;
}
export interface ResponseLoadConfig extends ResponseWithErrorInfo {
	readonly command: 'loadConfig';
	readonly repo: string;
	readonly config: GitRepoConfig | null;
}

export interface RequestLoadRepoInfo extends RepoRequest {
	readonly command: 'loadRepoInfo';
	// For this request, repo is the repository itself, and worktree is where Git commands run: the repository, or one of its linked worktrees
	readonly worktree: string;
	readonly refreshId: number;
	readonly showRemoteBranches: boolean;
	readonly showStashes: boolean;
	readonly hideRemotes: ReadonlyArray<string>;
	readonly hideHosts: ReadonlyArray<string>; // Remote hosts whose worktrees and branches are left out
	readonly hostChoice: HostChoice; // Leaves out, and doesn't refresh, the remote hosts it doesn't show, as hideHosts does
	readonly refreshHosts: boolean; // TRUE => the user asked for a refresh, so the remote hosts are refreshed too (they also are when the view loads the repository)
}
export interface ResponseLoadRepoInfo extends ResponseWithErrorInfo {
	readonly command: 'loadRepoInfo';
	readonly refreshId: number;
	readonly branches: ReadonlyArray<string>;
	readonly head: string | null;
	readonly remotes: ReadonlyArray<string>;
	readonly stashes: ReadonlyArray<GitStash>;
	readonly worktrees: ReadonlyArray<GitWorktree>; // The local worktrees, then each remote host's, in the order of `hosts`
	readonly hosts: ReadonlyArray<GitRemoteHost>; // The repository's remote hosts, in the config's order
	readonly isRepo: boolean;
}

export interface RequestLoadRepos extends BaseMessage {
	readonly command: 'loadRepos';
	readonly check: boolean;
}
export interface ResponseLoadRepos extends BaseMessage {
	readonly command: 'loadRepos';
	readonly repos: GitRepoSet;
	readonly lastActiveRepo: string | null;
	readonly loadViewTo: LoadGitTreeViewTo;
}

export const enum MergeActionOn {
	Branch = 'Branch',
	RemoteTrackingBranch = 'Remote-tracking Branch',
	Commit = 'Commit'
}
export interface RequestMerge extends RepoRequest {
	readonly command: 'merge';
	readonly obj: string;
	readonly actionOn: MergeActionOn;
	readonly createNewCommit: boolean;
	readonly squash: boolean;
	readonly noCommit: boolean;
}
export interface ResponseMerge extends ResponseWithErrorInfo {
	readonly command: 'merge';
	readonly actionOn: MergeActionOn;
}

export interface RequestOpenExtensionSettings extends BaseMessage {
	readonly command: 'openExtensionSettings';
}
export interface ResponseOpenExtensionSettings extends ResponseWithErrorInfo {
	readonly command: 'openExtensionSettings';
}

export interface RequestOpenExternalDirDiff extends RepoRequest {
	readonly command: 'openExternalDirDiff';
	readonly fromHash: string;
	readonly toHash: string;
	readonly isGui: boolean;
}
export interface ResponseOpenExternalDirDiff extends ResponseWithErrorInfo {
	readonly command: 'openExternalDirDiff';
}

export interface RequestOpenExternalUrl extends BaseMessage {
	readonly command: 'openExternalUrl';
	readonly url: string;
}
export interface ResponseOpenExternalUrl extends ResponseWithErrorInfo {
	readonly command: 'openExternalUrl';
}

export interface RequestOpenFile extends RepoRequest {
	readonly command: 'openFile';
	readonly hash: string;
	readonly filePath: string;
}
export interface ResponseOpenFile extends ResponseWithErrorInfo {
	readonly command: 'openFile';
}

/** Open a terminal in one of the repository's worktrees on this machine. `repo` is the repository. */
export interface RequestOpenTerminal extends RepoRequest {
	readonly command: 'openTerminal';
	readonly path: string; // The worktree's path. The terminal only opens if it is one of the repository's worktrees.
}
export interface ResponseOpenTerminal extends ResponseWithErrorInfo {
	readonly command: 'openTerminal';
}

export interface RequestOpenWorktree extends BaseMessage {
	readonly command: 'openWorktree';
	readonly path: string;
	readonly newWindow: boolean;
}
export interface ResponseOpenWorktree extends ResponseWithErrorInfo {
	readonly command: 'openWorktree';
}

/** Open a terminal on a remote host, in one of its worktrees. `repo` is the repository. */
export interface RequestOpenRemoteTerminal extends RepoRequest {
	readonly command: 'openRemoteTerminal';
	readonly host: string; // The host's name
	readonly path: string; // The worktree's path on the server
}
export interface ResponseOpenRemoteTerminal extends ResponseWithErrorInfo {
	readonly command: 'openRemoteTerminal';
}

/** Open a remote host's worktree in Visual Studio Code, with Remote-SSH. `repo` is the repository. */
export interface RequestOpenRemoteWorktree extends RepoRequest {
	readonly command: 'openRemoteWorktree';
	readonly host: string; // The host's name
	readonly path: string; // The worktree's path on the server
	readonly newWindow: boolean;
}
export interface ResponseOpenRemoteWorktree extends ResponseWithErrorInfo {
	readonly command: 'openRemoteWorktree';
}

export interface RequestPopStash extends RepoRequest {
	readonly command: 'popStash';
	readonly selector: string;
	readonly reinstateIndex: boolean;
}
export interface ResponsePopStash extends ResponseWithErrorInfo {
	readonly command: 'popStash';
}

export interface RequestPruneRemote extends RepoRequest {
	readonly command: 'pruneRemote';
	readonly name: string;
}
export interface ResponsePruneRemote extends ResponseWithErrorInfo {
	readonly command: 'pruneRemote';
}

export interface RequestPullBranch extends RepoRequest {
	readonly command: 'pullBranch';
	readonly branchName: string;
	readonly remote: string;
	readonly createNewCommit: boolean;
	readonly squash: boolean;
}
export interface ResponsePullBranch extends ResponseWithErrorInfo {
	readonly command: 'pullBranch';
}

export interface RequestPushBranch extends RepoRequest {
	readonly command: 'pushBranch';
	readonly branchName: string;
	readonly remotes: string[];
	readonly setUpstream: boolean;
	readonly mode: GitPushBranchMode;
	readonly willUpdateBranchConfig: boolean;
}
export interface ResponsePushBranch extends ResponseWithMultiErrorInfo {
	readonly command: 'pushBranch';
	readonly willUpdateBranchConfig: boolean;
}

export interface RequestPushStash extends RepoRequest {
	readonly command: 'pushStash';
	readonly message: string;
	readonly includeUntracked: boolean;
}
export interface ResponsePushStash extends ResponseWithErrorInfo {
	readonly command: 'pushStash';
}

export interface RequestPushTag extends RepoRequest {
	readonly command: 'pushTag';
	readonly tagName: string;
	readonly remotes: string[];
	readonly commitHash: string;
	readonly skipRemoteCheck: boolean;
}
export interface ResponsePushTag extends ResponseWithMultiErrorInfo {
	readonly command: 'pushTag';
	readonly repo: string;
	readonly tagName: string;
	readonly remotes: string[];
	readonly commitHash: string;
}

export const enum RebaseActionOn {
	Branch = 'Branch',
	Commit = 'Commit'
}
export interface RequestRebase extends RepoRequest {
	readonly command: 'rebase';
	readonly obj: string;
	readonly actionOn: RebaseActionOn;
	readonly ignoreDate: boolean;
	readonly interactive: boolean;
}
export interface ResponseRebase extends ResponseWithErrorInfo {
	readonly command: 'rebase';
	readonly actionOn: RebaseActionOn;
	readonly interactive: boolean;
}

export interface ResponseRefresh extends BaseMessage {
	readonly command: 'refresh';
}

export interface RequestRenameBranch extends RepoRequest {
	readonly command: 'renameBranch';
	readonly oldName: string;
	readonly newName: string;
}
export interface ResponseRenameBranch extends ResponseWithErrorInfo {
	readonly command: 'renameBranch';
}

export interface RequestRemoveWorktree extends RepoRequest {
	readonly command: 'removeWorktree';
	readonly path: string;
	readonly force: boolean;
}
export interface ResponseRemoveWorktree extends ResponseWithErrorInfo {
	readonly command: 'removeWorktree';
}

/** Remove a worktree on a remote host. `repo` is the repository. */
export interface RequestRemoveRemoteWorktree extends RepoRequest {
	readonly command: 'removeRemoteWorktree';
	readonly host: string; // The host's name
	readonly path: string; // The worktree's path on the server
	readonly force: boolean;
}
export interface ResponseRemoveRemoteWorktree extends ResponseWithErrorInfo {
	readonly command: 'removeRemoteWorktree';
}

export interface RequestRescanForRepos extends BaseMessage {
	readonly command: 'rescanForRepos';
}

export interface RequestResetFileToRevision extends RepoRequest {
	readonly command: 'resetFileToRevision';
	readonly commitHash: string;
	readonly filePath: string;
}
export interface ResponseResetFileToRevision extends ResponseWithErrorInfo {
	readonly command: 'resetFileToRevision';
}

export interface RequestResetToCommit extends RepoRequest {
	readonly command: 'resetToCommit';
	readonly commit: string;
	readonly resetMode: GitResetMode;
}
export interface ResponseResetToCommit extends ResponseWithErrorInfo {
	readonly command: 'resetToCommit';
}

export interface RequestRevertCommit extends RepoRequest {
	readonly command: 'revertCommit';
	readonly commitHash: string;
	readonly parentIndex: number;
}
export interface ResponseRevertCommit extends ResponseWithErrorInfo {
	readonly command: 'revertCommit';
}

export interface RequestSetGlobalViewState extends BaseMessage {
	readonly command: 'setGlobalViewState';
	readonly state: GitTreeViewGlobalState;
}
export interface ResponseSetGlobalViewState extends ResponseWithErrorInfo {
	readonly command: 'setGlobalViewState';
}

export interface RequestSetRepoState extends RepoRequest {
	readonly command: 'setRepoState';
	readonly state: GitRepoState;
}

export interface RequestSetWorkspaceViewState extends BaseMessage {
	readonly command: 'setWorkspaceViewState';
	readonly state: GitTreeViewWorkspaceState;
}
export interface ResponseSetWorkspaceViewState extends ResponseWithErrorInfo {
	readonly command: 'setWorkspaceViewState';
}

export interface RequestShowErrorDialog extends BaseMessage {
	readonly command: 'showErrorMessage';
	readonly message: string;
}

export interface RequestStartCodeReview extends RepoRequest {
	readonly command: 'startCodeReview';
	readonly id: string;
	readonly files: string[];
	readonly lastViewedFile: string | null;
	readonly commitHash: string;
	readonly compareWithHash: string | null;
}
export interface ResponseStartCodeReview extends ResponseWithErrorInfo {
	readonly command: 'startCodeReview';
	readonly codeReview: CodeReview;
	readonly commitHash: string;
	readonly compareWithHash: string | null;
}

export interface RequestTagDetails extends RepoRequest {
	readonly command: 'tagDetails';
	readonly tagName: string;
	readonly commitHash: string;
}
export interface ResponseTagDetails extends ResponseWithErrorInfo {
	readonly command: 'tagDetails';
	readonly tagName: string;
	readonly commitHash: string;
	readonly details: GitTagDetails | null;
}

export interface RequestUpdateCodeReview extends RepoRequest {
	readonly command: 'updateCodeReview';
	readonly id: string;
	readonly remainingFiles: string[];
	readonly lastViewedFile: string | null;
}

export interface ResponseUpdateCodeReview extends ResponseWithErrorInfo {
	readonly command: 'updateCodeReview';
}

export interface RequestViewDiff extends RepoRequest {
	readonly command: 'viewDiff';
	readonly fromHash: string;
	readonly toHash: string;
	readonly oldFilePath: string;
	readonly newFilePath: string;
	readonly type: GitFileStatus;
}
export interface ResponseViewDiff extends ResponseWithErrorInfo {
	readonly command: 'viewDiff';
}

export interface RequestViewDiffWithWorkingFile extends RepoRequest {
	readonly command: 'viewDiffWithWorkingFile';
	readonly hash: string;
	readonly filePath: string;
}
export interface ResponseViewDiffWithWorkingFile extends ResponseWithErrorInfo {
	readonly command: 'viewDiffWithWorkingFile';
}

export interface RequestViewFileAtRevision extends RepoRequest {
	readonly command: 'viewFileAtRevision';
	readonly hash: string;
	readonly filePath: string;
}
export interface ResponseViewFileAtRevision extends ResponseWithErrorInfo {
	readonly command: 'viewFileAtRevision';
}

export interface RequestViewScm extends BaseMessage {
	readonly command: 'viewScm';
}
export interface ResponseViewScm extends ResponseWithErrorInfo {
	readonly command: 'viewScm';
}

/* The Manage panel: each host's worktrees, their sizes on disk, and Fast-forward */

/**
 * How a worktree relates to its repository's main branch:
 * - `main`: it has the main branch checked out.
 * - `detached`: it has no branch checked out.
 * - `compared`: the commits only it has (`ahead`), and the commits only main has (`behind`).
 * - `unknown`: there's no main branch, its folder is missing, or Git couldn't compare them.
 */
export type WorktreeMainRelation =
	{ readonly kind: 'main' }
	| { readonly kind: 'detached' }
	| { readonly kind: 'compared', readonly ahead: number, readonly behind: number }
	| { readonly kind: 'unknown' };

/** A worktree as the Manage panel shows it. */
export interface ManagedWorktree {
	readonly worktree: GitWorktree; // `path` names it in a Fast-forward request
	readonly changes: number | null; // The number of `git status --porcelain` lines, untracked files included. NULL => the status couldn't be read.
	readonly relation: WorktreeMainRelation;
	readonly fastForwardRefusal: string | null; // NULL => Fast-forward can run, otherwise why it can't
}

/** What the Manage panel shows of a host's Git. */
export interface ManagedHostGit {
	readonly mainBranch: string | null; // NULL => there's none, and mainBranchError says why
	readonly mainBranchError: string | null;
	readonly worktrees: ReadonlyArray<ManagedWorktree>; // The main worktree first
}

/** The space on a disk, in kilobytes, from `df -Pk`. */
export interface DiskSpace {
	readonly total: number;
	readonly used: number;
	readonly free: number;
}

/** A folder's own size on disk, in kilobytes: the worktrees and the Git folder inside it are left out, since they have their own rows. */
export interface ManagedSize {
	readonly path: string; // The worktree's path as ManagedWorktree gave it, or the Git folder's path
	readonly size: number | null; // NULL => it couldn't be measured
}

/** What the Manage panel shows of a host's disk. */
export interface ManagedHostSizes {
	readonly disk: DiskSpace | null; // The disk that holds the main worktree. NULL => df couldn't read it.
	readonly worktrees: ReadonlyArray<ManagedSize>; // One per worktree whose folder exists
	readonly gitData: ManagedSize; // The Git folder that all the worktrees share
	readonly warning: string | null; // Why the sizes may be too small, when du couldn't read some folders
}

export interface RequestLoadWorktreeStats extends RepoRequest {
	readonly command: 'loadWorktreeStats';
	readonly hosts: ReadonlyArray<string | null>; // NULL => this machine, otherwise a remote host's name
	readonly requestId: number;
}
export interface ResponseLoadWorktreeStats extends ResponseWithErrorInfo {
	// Each host answers on its own: first its Git (`part` git), then its sizes (`part` sizes), which can take much longer.
	// A host whose Git couldn't be read answers once, with the error.
	readonly command: 'loadWorktreeStats';
	readonly repo: string;
	readonly requestId: number;
	readonly host: string | null;
	readonly part: 'git' | 'sizes';
	readonly git: ManagedHostGit | null;
	readonly sizes: ManagedHostSizes | null;
}

export interface RequestFastForwardWorktree extends RepoRequest {
	readonly command: 'fastForwardWorktree';
	readonly host: string | null; // NULL => this machine
	readonly path: string; // The worktree's path, which the extension checks against its own list
}
export interface ResponseFastForwardWorktree extends ResponseWithErrorInfo {
	readonly command: 'fastForwardWorktree';
	readonly repo: string;
	readonly host: string | null;
	readonly path: string;
}

export type RequestMessage =
	RequestAddRemote
	| RequestBrowseRemoteHost
	| RequestCheckRemoteHost
	| RequestCreateRemoteHostRepository
	| RequestLoadRemoteHosts
	| RequestRemoveRemoteHost
	| RequestRunRemoteHostGit
	| RequestSaveRemoteHost
	| RequestAddTag
	| RequestApplyStash
	| RequestAskRemoteHostFetchConsent
	| RequestBranchFromStash
	| RequestCheckoutBranch
	| RequestCheckoutCommit
	| RequestCherrypickCommit
	| RequestCleanUntrackedFiles
	| RequestCommitDetails
	| RequestCompareCommits
	| RequestCopyFilePath
	| RequestCopyToClipboard
	| RequestCreateArchive
	| RequestCreateBranch
	| RequestCreateWorktree
	| RequestCreateRemoteWorktree
	| RequestCreatePullRequest
	| RequestDeleteBranch
	| RequestDeleteRemote
	| RequestDeleteRemoteBranch
	| RequestDeleteTag
	| RequestDeleteUserDetails
	| RequestDropCommit
	| RequestDropStash
	| RequestEditRemote
	| RequestEditUserDetails
	| RequestEndCodeReview
	| RequestExportRepoConfig
	| RequestFetch
	| RequestFetchAvatar
	| RequestFetchIntoLocalBranch
	| RequestLoadCommits
	| RequestLoadConfig
	| RequestLoadRepoInfo
	| RequestLoadRepos
	| RequestMerge
	| RequestOpenExtensionSettings
	| RequestOpenExternalDirDiff
	| RequestOpenExternalUrl
	| RequestOpenFile
	| RequestOpenTerminal
	| RequestOpenWorktree
	| RequestOpenRemoteTerminal
	| RequestOpenRemoteWorktree
	| RequestPopStash
	| RequestPruneRemote
	| RequestPullBranch
	| RequestPushBranch
	| RequestPushStash
	| RequestPushTag
	| RequestRebase
	| RequestRemoveWorktree
	| RequestRemoveRemoteWorktree
	| RequestRenameBranch
	| RequestRescanForRepos
	| RequestResetFileToRevision
	| RequestResetToCommit
	| RequestRevertCommit
	| RequestSetGlobalViewState
	| RequestSetRepoState
	| RequestSetWorkspaceViewState
	| RequestShowErrorDialog
	| RequestStartCodeReview
	| RequestTagDetails
	| RequestUpdateCodeReview
	| RequestViewDiff
	| RequestViewDiffWithWorkingFile
	| RequestViewFileAtRevision
	| RequestViewScm
	| RequestLoadWorktreeStats
	| RequestFastForwardWorktree;

export type ResponseMessage =
	ResponseAddRemote
	| ResponseBrowseRemoteHost
	| ResponseCheckRemoteHost
	| ResponseCreateRemoteHostRepository
	| ResponseLoadRemoteHosts
	| ResponseRemoveRemoteHost
	| ResponseRunRemoteHostGit
	| ResponseSaveRemoteHost
	| ResponseAddTag
	| ResponseApplyStash
	| ResponseAskRemoteHostFetchConsent
	| ResponseBranchFromStash
	| ResponseCheckoutBranch
	| ResponseCheckoutCommit
	| ResponseCherrypickCommit
	| ResponseCleanUntrackedFiles
	| ResponseCompareCommits
	| ResponseCommitDetails
	| ResponseCopyFilePath
	| ResponseCopyToClipboard
	| ResponseCreateArchive
	| ResponseCreateBranch
	| ResponseCreateWorktree
	| ResponseCreateRemoteWorktree
	| ResponseCreatePullRequest
	| ResponseDeleteBranch
	| ResponseDeleteRemote
	| ResponseDeleteRemoteBranch
	| ResponseDeleteTag
	| ResponseDeleteUserDetails
	| ResponseDropCommit
	| ResponseDropStash
	| ResponseEditRemote
	| ResponseEditUserDetails
	| ResponseExportRepoConfig
	| ResponseFetch
	| ResponseFetchAvatar
	| ResponseFetchIntoLocalBranch
	| ResponseLoadCommits
	| ResponseLoadConfig
	| ResponseLoadRepoInfo
	| ResponseLoadRepos
	| ResponseMerge
	| ResponseOpenExtensionSettings
	| ResponseOpenExternalDirDiff
	| ResponseOpenExternalUrl
	| ResponseOpenFile
	| ResponseOpenTerminal
	| ResponseOpenWorktree
	| ResponseOpenRemoteTerminal
	| ResponseOpenRemoteWorktree
	| ResponsePopStash
	| ResponsePruneRemote
	| ResponsePullBranch
	| ResponsePushBranch
	| ResponsePushStash
	| ResponsePushTag
	| ResponseRebase
	| ResponseRefresh
	| ResponseRemoveWorktree
	| ResponseRemoveRemoteWorktree
	| ResponseRenameBranch
	| ResponseResetFileToRevision
	| ResponseResetToCommit
	| ResponseRevertCommit
	| ResponseSetGlobalViewState
	| ResponseSetWorkspaceViewState
	| ResponseStartCodeReview
	| ResponseTagDetails
	| ResponseUpdateCodeReview
	| ResponseViewDiff
	| ResponseViewDiffWithWorkingFile
	| ResponseViewFileAtRevision
	| ResponseViewScm
	| ResponseLoadWorktreeStats
	| ResponseFastForwardWorktree;


/** Helper Types */

type PrimitiveTypes = string | number | boolean | symbol | bigint | undefined | null;

/**
 * Make all properties in T writeable
 */
export type Writeable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Make all properties in T recursively readonly
 */
export type DeepReadonly<T> = T extends PrimitiveTypes
	? T
	: T extends (Array<infer U> | ReadonlyArray<infer U>)
	? ReadonlyArray<DeepReadonly<U>>
	: { readonly [K in keyof T]: DeepReadonly<T[K]> };

/**
 * Make all properties in T recursively writeable
 */
export type DeepWriteable<T> = T extends PrimitiveTypes
	? T
	: T extends (Array<infer U> | ReadonlyArray<infer U>)
	? Array<DeepWriteable<U>>
	: { -readonly [K in keyof T]: DeepWriteable<T[K]> };
