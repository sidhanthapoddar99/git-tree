#!/usr/bin/env bash
# Builds the demo repository that the Extension Development Host opens (see CONTRIBUTING.md).
#
# It writes, under dev-workspace/ (or under $DEMO_DIR when that is set):
#   demo-repo/             a small TypeScript project, "Skycast", with about three months of history
#                          from four authors: feature branches, merges, a release branch, tags,
#                          a stash, uncommitted changes, and remote branches
#   demo-repo/.worktrees/  two linked worktrees inside the repository
#   demo-hotfix/           a linked worktree outside the repository
#   demo-origin.git/       a bare repository that acts as the remote "origin"
#
# Usage: [DEMO_DIR=/some/folder] scripts/make-demo-repo.sh [--force | --if-missing]
#   --force       delete and rebuild the demo folders
#   --if-missing  do nothing when the demo repository already exists (used before F5)
#   DEMO_DIR      build the demo somewhere else, for example a throwaway copy in /tmp
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WS="${DEMO_DIR:-$ROOT/dev-workspace}"
REPO="$WS/demo-repo"
ORIGIN="$WS/demo-origin.git"
HOTFIX="$WS/demo-hotfix"

case "${1:-}" in
	--if-missing) [ -d "$REPO/.git" ] && exit 0 ;;
	--force) ;;
	"") if [ -e "$REPO" ]; then echo "$REPO exists. Use --force to rebuild it." >&2; exit 1; fi ;;
	*) echo "Usage: $0 [--force | --if-missing]" >&2; exit 2 ;;
esac

# Only ever delete the three generated folders
if [ -d "$REPO/.git" ]; then git -C "$REPO" worktree list --porcelain | sed -n 's/^worktree //p' | tail -n +2 | while read -r wt; do git -C "$REPO" worktree remove --force "$wt" 2>/dev/null || true; done; fi
rm -rf "$REPO" "$ORIGIN" "$HOTFIX"
mkdir -p "$WS"

AUTHORS=("Ada Park|ada.park@example.com" "Ravi Menon|ravi.menon@example.com" "Lena Fischer|lena.fischer@example.com" "Tomás Ortega|tomas.ortega@example.com")
CLOCK=$(date -d '2026-07-01 09:12:00 UTC' +%s)

git init -q -b main "$REPO"
cd "$REPO"
git config user.name "Ada Park"
git config user.email "ada.park@example.com"
git config commit.gpgsign false
git config tag.gpgsign false

# commit AUTHOR_INDEX "message" — commits what is staged, at the next point on the demo clock
commit() {
	local who="${AUTHORS[$1]}"
	CLOCK=$((CLOCK + 3600 * (3 + RANDOM % 20)))
	GIT_AUTHOR_NAME="${who%%|*}" GIT_AUTHOR_EMAIL="${who##*|}" GIT_COMMITTER_NAME="${who%%|*}" GIT_COMMITTER_EMAIL="${who##*|}" \
		GIT_AUTHOR_DATE="@$CLOCK +0000" GIT_COMMITTER_DATE="@$CLOCK +0000" git commit -q --no-verify -m "$2"
}
# change AUTHOR_INDEX FILE "line" "message" — appends a line to a file and commits it
change() {
	mkdir -p "$(dirname "$2")"
	echo "$3" >> "$2"
	git add -A
	commit "$1" "$4"
}
merge() {
	local who="${AUTHORS[$1]}"
	CLOCK=$((CLOCK + 3600 * 2))
	GIT_AUTHOR_NAME="${who%%|*}" GIT_AUTHOR_EMAIL="${who##*|}" GIT_COMMITTER_NAME="${who%%|*}" GIT_COMMITTER_EMAIL="${who##*|}" \
		GIT_AUTHOR_DATE="@$CLOCK +0000" GIT_COMMITTER_DATE="@$CLOCK +0000" git merge -q --no-ff --no-edit -m "$3" "$2"
}
tag() {
	GIT_COMMITTER_DATE="@$CLOCK +0000" git tag -a "$1" -m "$2"
}
RANDOM=42

# ---- The first weeks on main
cat > README.md <<'EOF'
# Skycast

A small command-line weather forecast.
EOF
echo '{ "name": "skycast", "version": "0.1.0" }' > package.json
git add -A; commit 0 "Initial commit"
change 0 src/cli.ts "export function main(args: string[]) {}" "Add the command-line entry point"
change 1 src/api.ts "export async function fetchWeather(city: string) {}" "Fetch current weather from the API"
change 1 src/api.ts "// Retry once on a network error" "Retry a failed request once"
change 0 src/format.ts "export function formatTemperature(c: number) {}" "Format temperatures for the terminal"
change 2 .github/workflows/ci.yml "name: CI" "Run the tests on every push"
change 2 tests/format.test.ts "test('formats 21.5', () => {});" "Test temperature formatting"
change 0 README.md "Run \`skycast <city>\`." "Document basic usage"
tag v0.1.0 "Skycast 0.1.0: current weather for one city"

# ---- Short-lived branches, each merged after main has moved on
while IFS='|' read -r -u 3 branch who file first second onmain; do
	git switch -q -c "$branch"
	change "$who" "$file" "// $first" "$first"
	change "$who" "$file" "// $second" "$second"
	git switch -q main
	change $(((who + 1) % 4)) CHANGES.md "- $onmain" "$onmain"
	merge 0 "$branch" "Merge branch '$branch'"
	git branch -q -d "$branch"  # merged short-lived branches get deleted, as in most repositories
done 3<<'EOF'
feature/geocode|1|src/geocode.ts|Look up cities by name|Prefer the most populated match|Show the city name in the header
docs/install|2|docs/install.md|Write installation steps|Add Homebrew instructions|Handle Ctrl+C cleanly
fix/retry-backoff|3|src/api.ts|Back off between retries|Cap the retry delay at 8 seconds|Print the API's error message
feature/colours|2|src/format.ts|Colour temperatures by range|Respect NO_COLOR|Round temperatures to one decimal
chore/eslint|0|.eslintrc.json|Add ESLint|Fix the lint warnings|Add a --version flag
EOF

# ---- Forecasts, built on a feature branch while main moves on
git switch -q -c feature/forecast
change 1 src/forecast.ts "export async function fetchForecast(city: string, days: number) {}" "Fetch a multi-day forecast"
change 1 src/forecast.ts "// Group hourly data into days" "Group hourly forecast data into days"
git switch -q main
change 3 src/config.ts "export const defaults = { units: 'metric' };" "Read defaults from a config file"
change 3 src/config.ts "// Look in XDG_CONFIG_HOME first" "Follow XDG_CONFIG_HOME for the config file"
git switch -q feature/forecast
change 0 src/format.ts "export function formatForecastTable() {}" "Print the forecast as a table"
change 1 tests/forecast.test.ts "test('groups 48 hours into 2 days', () => {});" "Test forecast grouping"
git switch -q main
merge 0 feature/forecast "Merge branch 'feature/forecast'"

# ---- Units, and a timezone fix
git switch -q -c feature/units
change 2 src/units.ts "export type Units = 'metric' | 'imperial';" "Add imperial units"
change 2 src/cli.ts "// --units flag" "Add the --units flag"
git switch -q main
git switch -q -c fix/timezone
change 3 src/forecast.ts "// Use the city's timezone for day boundaries" "Fix days split at UTC midnight instead of local midnight"
git switch -q main
merge 3 fix/timezone "Merge branch 'fix/timezone'"
git switch -q feature/units
change 2 src/units.ts "// Wind speed in mph for imperial" "Show wind speed in mph for imperial units"
change 2 tests/units.test.ts "test('converts 0C to 32F', () => {});" "Test unit conversion"
git switch -q main
merge 2 feature/units "Merge branch 'feature/units'"
for msg in "Tidy the CLI help text" "Update dependencies" "Explain the config file in the README" "Speed up the test suite"; do
	change $((RANDOM % 4)) CHANGES.md "- $msg" "$msg"
done

# ---- Release 1.0 on a release branch
git switch -q -c release/1.0
sed -i 's/"0.1.0"/"1.0.0"/' package.json; git add -A; commit 0 "Bump version to 1.0.0"
change 0 CHANGES.md "## 1.0.0" "Write the 1.0.0 release notes"
tag v1.0.0 "Skycast 1.0.0: forecasts and units"
git switch -q main
merge 0 release/1.0 "Merge branch 'release/1.0'"

# ---- Work after 1.0
change 1 src/cache.ts "export const cache = new Map();" "Cache API responses for ten minutes"
change 1 src/cache.ts "// Evict the oldest entry when full" "Limit the cache to 100 entries"
git switch -q -c feature/charts
change 2 src/chart.ts "export function sparkline(values: number[]) {}" "Draw temperature sparklines"
change 2 src/chart.ts "// Colour by temperature" "Colour sparklines by temperature"
git switch -q main
change 3 src/cli.ts "// --json output" "Add --json output"
change 0 src/api.ts "// Read the API key from SKYCAST_KEY" "Read the API key from an environment variable"
git tag nightly
change 3 README.md "Set \`SKYCAST_KEY\` to your API key." "Document the API key"

git switch -q -c feature/alerts
change 1 src/alerts.ts "export async function fetchAlerts(city: string) {}" "Fetch severe weather alerts"
change 1 src/alerts.ts "// Show alerts above the forecast" "Show alerts above the forecast"
git switch -q main
git switch -q -c fix/cache-crash
change 3 src/cache.ts "// Guard against an empty response" "Fix a crash when the API returns an empty body"
git switch -q main
change 0 CHANGES.md "- Start work on 1.1" "Start work on 1.1"

# ---- The remote: push, then let main move ahead of origin/main
git init -q --bare -b main "$ORIGIN"
git remote add origin "$ORIGIN"
git push -q origin main release/1.0 feature/forecast feature/charts --tags
git push -q origin main:refs/heads/feature/i18n
change 2 src/cli.ts "// Exit code 2 for an unknown city" "Exit with code 2 for an unknown city"
change 0 README.md "See CHANGES.md for the release notes." "Link the release notes"

# ---- A stash, and uncommitted changes on main
echo "// TODO: cache forecasts too" >> src/cache.ts
git stash push -q -m "Cache forecasts too (half done)"
echo "Skycast needs Node.js 20 or later." >> README.md
echo "export const theme = 'auto';" > src/theme.ts

# ---- Worktrees: two inside the repository (the default .worktrees folder), one outside it
echo ".worktrees/" >> .git/info/exclude
git worktree add -q .worktrees/alerts feature/alerts
echo "// Sort alerts by severity" >> .worktrees/alerts/src/alerts.ts
echo "test('sorts by severity', () => {});" > .worktrees/alerts/tests/alerts.test.ts
git worktree add -q "$HOTFIX" fix/cache-crash
echo "// Log the empty response" >> "$HOTFIX/src/cache.ts"
git worktree add -q --detach .worktrees/review v1.0.0

echo "Built the demo repository: $REPO"
git worktree list
